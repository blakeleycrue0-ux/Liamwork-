import { getDb, nowIso } from '../index.js';

/** One row per morning summary, kept so a report can be re-read or re-sent. */

const parse = (row) =>
  row && {
    ...row,
    payload: safeJson(row.payload, {}),
    recipients: safeJson(row.recipients, []),
  };

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function saveReport(report, { at = nowIso() } = {}) {
  const db = await getDb();
  const payload = JSON.stringify(report.payload ?? {});

  const row = await db.get(
    `INSERT INTO daily_reports (
       report_date, generated_at, window_start, window_end, total_changes,
       high_priority, medium_priority, low_priority, websites_total, websites_quiet,
       daily_summary, payload, model, input_tokens, output_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (report_date) DO UPDATE SET
       generated_at = EXCLUDED.generated_at,
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       total_changes = EXCLUDED.total_changes,
       high_priority = EXCLUDED.high_priority,
       medium_priority = EXCLUDED.medium_priority,
       low_priority = EXCLUDED.low_priority,
       websites_total = EXCLUDED.websites_total,
       websites_quiet = EXCLUDED.websites_quiet,
       daily_summary = EXCLUDED.daily_summary,
       payload = EXCLUDED.payload,
       model = EXCLUDED.model,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens
     RETURNING *`,
    [
      report.date,
      at,
      report.windowStart,
      report.windowEnd,
      report.totalChanges ?? 0,
      report.highPriority ?? 0,
      report.mediumPriority ?? 0,
      report.lowPriority ?? 0,
      report.websitesTotal ?? 0,
      report.websitesQuiet ?? 0,
      report.dailySummary ?? null,
      payload,
      report.model ?? null,
      report.inputTokens ?? 0,
      report.outputTokens ?? 0,
    ],
  );
  return parse(row);
}

export async function markSent(reportDate, recipients, { at = nowIso() } = {}) {
  const db = await getDb();
  await db.run('UPDATE daily_reports SET sent_at = ?, recipients = ?, error = NULL WHERE report_date = ?', [
    at,
    JSON.stringify(recipients),
    reportDate,
  ]);
}

export async function markFailed(reportDate, message) {
  const db = await getDb();
  await db.run('UPDATE daily_reports SET error = ? WHERE report_date = ?', [
    String(message).slice(0, 500),
    reportDate,
  ]);
}

export async function getReport(reportDate) {
  const db = await getDb();
  return parse(await db.get('SELECT * FROM daily_reports WHERE report_date = ?', [reportDate]));
}

export async function listReports(limit = 30) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT id, report_date, generated_at, total_changes, high_priority, medium_priority,
            low_priority, websites_total, websites_quiet, daily_summary, model, sent_at, error
     FROM daily_reports ORDER BY report_date DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

export async function lastSentDate() {
  const db = await getDb();
  const row = await db.get(
    'SELECT report_date FROM daily_reports WHERE sent_at IS NOT NULL ORDER BY report_date DESC LIMIT 1',
  );
  return row?.report_date ?? null;
}
