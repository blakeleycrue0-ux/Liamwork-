import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getAllSettings, getSetting } from '../db/repositories/settings.repo.js';
import {
  attachToReport,
  changesForReport,
  countPendingForReport,
} from '../db/repositories/changes.repo.js';
import { listWebsites } from '../db/repositories/websites.repo.js';
import { getReport, lastSentDate, markFailed, markSent, saveReport } from '../db/repositories/reports.repo.js';
import { activeRecipients } from '../notifications/notifier.js';
import { sendMail } from '../notifications/mailer.js';
import { aiConfigured, DEFAULT_MODEL } from './analyze.js';
import { buildReportEmail } from './report.email.js';
import { dayWindow, previousDate, reportDue } from './window.js';

/**
 * Stage three: one report per morning, covering the previous calendar day.
 *
 * Everything that decides WHAT goes in the report has already happened by the
 * time we get here - each change carries its verdict and its priority from
 * the analyser. This module only selects the right day, counts, writes one
 * paragraph of framing, stores the result and sends exactly one email.
 */

const PRIORITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const SummarySchema = z.object({
  daily_summary: z
    .string()
    .describe(
      'Un párrafo corto en español, 2-4 frases: qué ha pasado hoy en conjunto. ' +
        'Nombra lo importante. Si no hay nada relevante, dilo en una frase.',
    ),
});

const SUMMARY_SYSTEM = `Escribes el párrafo de apertura del informe diario de un sistema que vigila páginas web de clubes deportivos.

Recibes la lista de cambios ya clasificados del día. Escribe 2-4 frases en español que le digan a alguien con prisa qué ha pasado.

- Empieza por lo importante. Si hay algo de prioridad alta, va primero y con su nombre.
- Concreto, no genérico: "tres clubes han publicado los horarios de octubre", no "ha habido varias actualizaciones".
- No repitas la lista entera: el lector la tiene justo debajo.
- No inventes nada que no esté en los datos.
- Si no hay cambios, una sola frase basta.`;

/**
 * Builds the report for one day. Pure assembly over what is already stored,
 * so it can be re-run for any past date without re-crawling anything.
 */
export async function buildReport({ date, timeZone, model, client } = {}) {
  const settings = await getAllSettings();
  const zone = timeZone || settings.digest_timezone || 'Europe/Madrid';
  const reportDate = date || previousDate(zone);
  const window = dayWindow(reportDate, zone);

  // The report a previous run may already have stored for this date. Its id
  // is what lets a re-send reproduce the same content instead of dropping the
  // changes it already delivered.
  const existing = await getReport(reportDate);
  const changes = await changesForReport({ date: reportDate, reportId: existing?.id ?? null });
  const websites = await listWebsites({ activeOnly: true });

  const withChanges = new Set(changes.map((change) => change.website_id));
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const change of changes) counts[change.priority] = (counts[change.priority] ?? 0) + 1;
  // Anything older than the day being reported is a change an earlier report
  // should have carried and did not. Counted so the email can say so.
  const backlog = changes.filter((change) => change.change_date < reportDate).length;

  const items = changes
    .slice()
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        String(a.website_name).localeCompare(String(b.website_name)),
    )
    .map((change) => ({
      id: change.id,
      website: change.website_name,
      url: change.url || change.website_url,
      type: change.change_type,
      priority: change.priority,
      title: change.title ?? '',
      summary: change.summary ?? '',
      what_changed: change.what_changed ?? '',
      previous_value: change.previous_value ?? '',
      new_value: change.new_value ?? '',
      change_date: change.change_date,
    }));

  const summary = await writeDailySummary(items, {
    date: reportDate,
    model: model ?? (await getSetting('analysis_model', DEFAULT_MODEL)),
    client,
  });

  const payload = {
    date: reportDate,
    total_changes: items.length,
    high_priority: counts.HIGH,
    medium_priority: counts.MEDIUM,
    low_priority: counts.LOW,
    changes: items.map(({ id, ...rest }) => rest),
    pending_from_previous_days: backlog,
    daily_summary: summary.text,
  };

  const saved = await saveReport({
    date: reportDate,
    windowStart: window.start,
    windowEnd: window.end,
    totalChanges: items.length,
    highPriority: counts.HIGH,
    mediumPriority: counts.MEDIUM,
    lowPriority: counts.LOW,
    websitesTotal: websites.length,
    websitesQuiet: websites.length - withChanges.size,
    dailySummary: summary.text,
    payload,
    model: summary.model,
    inputTokens: summary.usage.input,
    outputTokens: summary.usage.output,
  });

  // Deliberately NOT marked as reported here. A report that is only built -
  // a preview, or one whose send then fails - must leave its changes pending,
  // or they vanish from every later report exactly as they used to.

  return {
    ...saved,
    changeIds: items.map((item) => item.id),
    backlog,
    // The stored column is report_date; everything downstream reads `date`.
    date: reportDate,
    payload,
    window,
    timeZone: zone,
    websitesTotal: websites.length,
    websitesQuiet: websites.length - withChanges.size,
  };
}

/**
 * One short paragraph of framing. A single cheap call, skipped entirely when
 * there is nothing to frame - which on a quiet day is most days.
 */
async function writeDailySummary(items, { date, model, client }) {
  const empty = { model: null, usage: { input: 0, output: 0 } };

  if (!items.length) {
    return { ...empty, text: 'No se ha detectado ningún cambio relevante en las webs vigiladas.' };
  }
  if (!aiConfigured()) {
    const high = items.filter((item) => item.priority === 'HIGH').length;
    return {
      ...empty,
      text:
        `${items.length} cambio(s) detectado(s)` +
        (high ? `, ${high} de prioridad alta.` : '.') +
        ' (Resumen automático: falta ANTHROPIC_API_KEY para redactarlo.)',
    };
  }

  const lines = items
    .map(
      (item) =>
        `- [${item.priority}] [${item.type}] ${item.website}: ${item.title}. ${item.summary}`.trim(),
    )
    .join('\n');

  try {
    const anthropic = client ?? new Anthropic();
    const response = await anthropic.messages.parse({
      model,
      max_tokens: 2000,
      system: [{ type: 'text', text: SUMMARY_SYSTEM, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: zodOutputFormat(SummarySchema) },
      messages: [{ role: 'user', content: `Cambios del ${date}:\n\n${lines}` }],
    });

    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return { ...empty, text: `${items.length} cambio(s) detectado(s).` };
    }
    return {
      text: response.parsed_output.daily_summary,
      model: response.model ?? model,
      usage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
      },
    };
  } catch (error) {
    console.error(`[report] daily summary failed: ${error.message}`);
    return { ...empty, text: `${items.length} cambio(s) detectado(s).` };
  }
}

/**
 * Builds the report if needed and sends it. Exactly one email per day:
 * `daily_reports.sent_at` is the lock, so a scheduler that fires twice, or a
 * retry after a crash, cannot produce a second copy.
 */
export async function sendDailyReport({ date, force = false, now = new Date() } = {}) {
  const settings = await getAllSettings();
  const zone = settings.digest_timezone || 'Europe/Madrid';
  const reportDate = date || previousDate(zone, now);

  const existing = await getReport(reportDate);
  if (existing?.sent_at && !force) {
    return { sent: false, reason: 'already-sent', date: reportDate, sentAt: existing.sent_at };
  }

  const report = await buildReport({ date: reportDate, timeZone: zone });

  // A quiet day means the report really is empty. It cannot be reached while
  // anything is still pending, because buildReport now sweeps the backlog into
  // this very report - so "Sin cambios" can never go out over unsent changes.
  const quietDay = report.total_changes === 0;
  if (quietDay && !force && !(await getSetting('report_send_when_empty', 'true')).startsWith('t')) {
    await markSent(reportDate, []);
    return { sent: false, reason: 'no-changes', date: reportDate };
  }

  const recipients = await activeRecipients();
  if (!recipients.length) {
    await markFailed(reportDate, 'no hay trabajadores activos');
    return { sent: false, reason: 'no-active-workers', date: reportDate, changes: report.total_changes };
  }

  const email = buildReportEmail(report, { timeZone: zone });

  try {
    const info = await sendMail({ to: recipients, ...email });
    // Only now are the changes spent. The order matters: the mail has left,
    // so claiming them cannot lose anything, and if the send had thrown they
    // would still be waiting for the next report.
    await markSent(reportDate, recipients);
    await attachToReport(report.changeIds ?? [], report.id);
    return {
      sent: true,
      date: reportDate,
      changes: report.total_changes,
      backlog: report.backlog ?? 0,
      high: report.high_priority,
      medium: report.medium_priority,
      low: report.low_priority,
      recipients,
      messageId: info.messageId,
    };
  } catch (error) {
    await markFailed(reportDate, error.message);
    throw error;
  }
}

/** Shown in the dashboard so the next report is never a mystery. */
export async function reportStatus(now = new Date()) {
  const settings = await getAllSettings();
  const zone = settings.digest_timezone || 'Europe/Madrid';
  const hour = Number(settings.digest_hour ?? 7);
  const lastSent = await lastSentDate();
  const target = previousDate(zone, now);
  const existing = await getReport(target);
  const pending = await countPendingForReport({ date: target, reportId: existing?.id ?? null });

  return {
    timezone: zone,
    hour,
    covers_date: target,
    last_sent_date: lastSent,
    due: reportDue({ timeZone: zone, hour, lastSentDate: lastSent, now }),
    // Backlog included: this is what the next email would actually carry.
    pending_changes: pending,
    // The dashboard used to call this pending_items; kept so an older cached
    // script cannot show a blank number.
    pending_items: pending,
  };
}

export { reportDue };
