import { config } from '../config/index.js';
import { categoryLabel } from './analyze.js';

/**
 * The one email of the day.
 *
 * Laid out the way it was asked for: a rule, the date, the count, then the
 * changes grouped by priority with a coloured marker, then the summary and
 * how many websites had nothing to say. Both a plain-text and an HTML part,
 * because the text part is what lands readably on a watch or in a client
 * that blocks HTML.
 */

const MONTHS = [
  'ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO',
  'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE',
];

const GROUPS = [
  { key: 'HIGH', label: 'PRIORIDAD ALTA', dot: '\u{1F534}', colour: '#dc2626' },
  { key: 'MEDIUM', label: 'PRIORIDAD MEDIA', dot: '\u{1F7E0}', colour: '#ea580c' },
  { key: 'LOW', label: 'PRIORIDAD BAJA', dot: '\u{1F7E2}', colour: '#16a34a' },
];

const RULE = '━'.repeat(34);

export function formatDate(date) {
  const [year, month, day] = String(date ?? '').split('-').map(Number);
  if (!Number.isFinite(year) || !MONTHS[month - 1]) return String(date ?? '');
  return `${day} DE ${MONTHS[month - 1]} DE ${year}`;
}

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function groupByPriority(changes) {
  return GROUPS.map((group) => ({
    ...group,
    items: changes.filter((change) => change.priority === group.key),
  })).filter((group) => group.items.length);
}

function textBody(report, groups) {
  const lines = [
    RULE,
    'INFORME DIARIO DE WEBS',
    formatDate(report.date),
    RULE,
    '',
    report.total_changes
      ? `${plural(report.total_changes, 'cambio relevante detectado', 'cambios relevantes detectados')}`
      : 'Sin cambios relevantes',
    ...(report.backlog
      ? [`(${plural(report.backlog, 'viene de días anteriores', 'vienen de días anteriores')}, pendiente de informar)`]
      : []),
    ...(report.heldBack
      ? [`${plural(report.heldBack, 'cambio más queda', 'cambios más quedan')} para el próximo informe (límite por email: ${report.limit})`]
      : []),
    '',
  ];

  for (const group of groups) {
    lines.push(`${group.dot} ${group.label}`, '');
    for (const item of group.items) {
      const kind = categoryLabel(item.category);
      lines.push(
        `${item.website} — ${kind ? `${kind.icon} ${kind.label} · ` : ''}${
          item.type === 'NEW' ? 'Nuevo' : 'Actualizado'
        }`,
      );
      if (item.title) lines.push(item.title);
      if (item.change_date && item.change_date < report.date) {
        lines.push(`[atrasado: del ${item.change_date}]`);
      }
      if (item.summary) lines.push(item.summary);
      if (item.what_changed) lines.push('', `Qué cambió: ${item.what_changed}`);
      if (item.previous_value && item.new_value) {
        lines.push(`Antes: ${item.previous_value}`, `Ahora: ${item.new_value}`);
      }
      if (item.url) lines.push(item.url);
      // El borrador, separado y entre comillas: se selecciona y se pega.
      if (item.draft_message) {
        lines.push('', '\u{1F4AC} Mensaje borrador:', `"${item.draft_message}"`);
      }
      lines.push('');
    }
  }

  lines.push(
    RULE,
    '',
    'Resumen:',
    report.daily_summary || '—',
    '',
    `Webs sin cambios: ${report.websitesQuiet}/${report.websitesTotal}`,
    '',
  );
  if (config.mail.appBaseUrl) lines.push(`Ver todos los cambios: ${config.mail.appBaseUrl}`);
  if (config.brand.credit) lines.push('', config.brand.credit);

  return lines.join('\n');
}

function htmlBody(report, groups) {
  const sections = groups
    .map(
      (group) => `
      <tr><td style="padding:26px 0 10px">
        <div style="font:600 12px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.12em;color:${group.colour}">
          ${group.dot} ${group.label}
        </div>
      </td></tr>
      ${group.items.map((item) => card(item, group)).join('')}`,
    )
    .join('');

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Informe diario ${escapeHtml(report.date)}</title></head>
<body style="margin:0;background:#f6f6f7;padding:22px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e9;border-radius:14px">
  <tr><td style="padding:30px 30px 0">
    <div style="border-top:2px solid #111114"></div>
    <div style="font:600 13px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.16em;color:#6b7280;padding:16px 0 4px">
      INFORME DIARIO DE WEBS
    </div>
    <div style="font:700 26px/1.2 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111114;letter-spacing:-.02em">
      ${escapeHtml(formatDate(report.date))}
    </div>
    <div style="border-top:2px solid #111114;margin-top:16px"></div>
    <div style="font:400 16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111114;padding:18px 0 0">
      ${
        report.total_changes
          ? escapeHtml(plural(report.total_changes, 'cambio relevante detectado', 'cambios relevantes detectados'))
          : 'Sin cambios relevantes'
      }
    </div>
    ${
      report.backlog
        ? `<div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;padding:6px 0 0">
             ${escapeHtml(plural(report.backlog, 'viene de días anteriores', 'vienen de días anteriores'))}, pendiente de informar
           </div>`
        : ''
    }
    ${
      report.heldBack
        ? `<div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ea580c;padding:6px 0 0">
             ${escapeHtml(plural(report.heldBack, 'cambio más queda', 'cambios más quedan'))} para el próximo informe
           </div>`
        : ''
    }
  </td></tr>
  ${sections}
  <tr><td style="padding:26px 30px 0">
    <div style="border-top:1px solid #e6e6e9;padding-top:20px">
      <div style="font:600 12px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.12em;color:#6b7280">RESUMEN</div>
      <div style="font:400 15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#31313a;padding-top:10px">
        ${escapeHtml(report.daily_summary || '—')}
      </div>
      <div style="font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;padding-top:14px">
        Webs sin cambios: ${report.websitesQuiet}/${report.websitesTotal}
      </div>
    </div>
  </td></tr>
  ${
    config.mail.appBaseUrl
      ? `<tr><td style="padding:22px 30px 0">
           <a href="${escapeHtml(config.mail.appBaseUrl)}"
              style="display:inline-block;background:#111114;color:#ffffff;text-decoration:none;border-radius:8px;
                     padding:11px 18px;font:600 14px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
             Ver todos los cambios
           </a>
         </td></tr>`
      : ''
  }
  <tr><td style="padding:24px 30px 30px">
    <div style="font:400 12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#9ca3af;border-top:1px solid #e6e6e9;padding-top:16px">
      ${escapeHtml(config.brand.credit)}
    </div>
  </td></tr>
</table>
</body></html>`;
}

function card(item, group) {
  const label = item.type === 'NEW' ? 'Nuevo' : 'Actualizado';
  const kind = categoryLabel(item.category);
  // El borrador va en su propia caja, con borde y comillas: tiene que
  // leerse como "esto es texto para mandar", no como una nota más del aviso.
  const draft = item.draft_message
    ? `<div style="margin-top:12px;background:#f6f6f7;border-left:2px solid #c7c7cc;border-radius:0 8px 8px 0;padding:12px 14px">
         <div style="font:600 11px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.1em;color:#6b7280;text-transform:uppercase">
           \u{1F4AC} Mensaje borrador
         </div>
         <div style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#31313a;padding-top:8px;white-space:pre-wrap">${escapeHtml(item.draft_message)}</div>
       </div>`
    : '';
  const compare =
    item.previous_value && item.new_value
      ? `<div style="font:400 13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#31313a;background:#f6f6f7;border-radius:8px;padding:10px 12px;margin-top:10px">
           <span style="color:#9ca3af">Antes:</span> ${escapeHtml(item.previous_value)}<br>
           <span style="color:#9ca3af">Ahora:</span> ${escapeHtml(item.new_value)}
         </div>`
      : '';

  return `<tr><td style="padding:0 30px 12px">
    <div style="border-left:3px solid ${group.colour};padding:2px 0 2px 14px">
      <div style="font:600 11px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;letter-spacing:.1em;color:#9ca3af;text-transform:uppercase">
        ${escapeHtml(item.website)} &middot; ${kind ? `${kind.icon} ${escapeHtml(kind.label)} &middot; ` : ''}${label}${
          item.stale ? ` &middot; <span style="color:#ea580c">del ${escapeHtml(item.change_date)}</span>` : ''
        }
      </div>
      <div style="font:600 16px/1.4 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111114;padding-top:6px">
        ${
          item.url
            ? `<a href="${escapeHtml(item.url)}" style="color:#111114;text-decoration:none">${escapeHtml(item.title)}</a>`
            : escapeHtml(item.title)
        }
      </div>
      ${
        item.summary
          ? `<div style="font:400 14px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#31313a;padding-top:6px">${escapeHtml(item.summary)}</div>`
          : ''
      }
      ${
        item.what_changed
          ? `<div style="font:400 13px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#6b7280;padding-top:8px">
               <strong style="color:#31313a;font-weight:600">Qué cambió:</strong> ${escapeHtml(item.what_changed)}
             </div>`
          : ''
      }
      ${compare}
      ${draft}
    </div>
  </td></tr>`;
}

export function buildReportEmail(report, { timeZone } = {}) {
  const date = report.date ?? report.report_date ?? report.payload?.date ?? '';
  // A change carried over from an earlier day is flagged, so nobody has to
  // wonder why something from last Tuesday is in this morning's email.
  const changes = (report.payload?.changes ?? []).map((change) => ({
    ...change,
    stale: Boolean(change.change_date && change.change_date < date),
  }));
  const groups = groupByPriority(changes);

  const subject = report.total_changes
    ? `Informe diario · ${report.total_changes} cambio${report.total_changes === 1 ? '' : 's'}` +
      (report.high_priority ? ` (${report.high_priority} alta)` : '') +
      ` · ${date}`
    : `Informe diario · sin cambios · ${date}`;

  const shaped = {
    ...report,
    date,
    backlog: report.backlog ?? report.payload?.pending_from_previous_days ?? 0,
    heldBack: report.heldBack ?? report.payload?.held_back_for_next_report ?? 0,
    limit: report.limit ?? null,
    websitesQuiet: report.websitesQuiet ?? report.websites_quiet ?? 0,
    websitesTotal: report.websitesTotal ?? report.websites_total ?? 0,
    daily_summary: report.daily_summary ?? report.payload?.daily_summary ?? '',
    timeZone,
  };

  return { subject, text: textBody(shaped, groups), html: htmlBody(shaped, groups) };
}
