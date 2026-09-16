import { config } from '../config/index.js';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const longDate = (iso, timeZone) => {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('es-ES', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
};

/** The daily briefing, as a readable email rather than a dump of rows. */
export function buildDigestEmail({ summary, posts, date, timeZone }) {
  const count = posts.length;
  const subject = count
    ? `[Web Monitor] ${summary.headline}`.slice(0, 180)
    : '[Web Monitor] Sin novedades hoy';

  const textLines = [summary.headline, '', `Resumen del ${longDate(date, timeZone)}`, ''];
  for (const section of summary.sections) {
    textLines.push(`${section.title.toUpperCase()}`);
    for (const item of section.items) {
      textLines.push(`  · ${item.text}${item.url ? `\n    ${item.url}` : ''}`);
    }
    textLines.push('');
  }
  if (!count) textLines.push('No se ha detectado ninguna novedad en las webs vigiladas.', '');
  textLines.push('---', config.brand.credit, config.mail.appBaseUrl);

  const sectionsHtml = summary.sections
    .map(
      (section) => `
      <tr><td style="padding:22px 28px 0;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">
          ${escapeHtml(section.emoji)} ${escapeHtml(section.title)}
        </div>
        <table role="presentation" width="100%" style="margin-top:10px;border-collapse:collapse;">
          ${section.items
            .map(
              (item) => `
            <tr><td style="padding:10px 0;border-bottom:1px solid #eef0f3;">
              <div style="font-size:15px;color:#111827;line-height:1.5;">${escapeHtml(item.text)}</div>
              <div style="font-size:12px;color:#9ca3af;margin-top:3px;">
                ${escapeHtml(item.website)}${
                  item.url
                    ? ` · <a href="${escapeHtml(item.url)}" style="color:#2563eb;text-decoration:none;">abrir</a>`
                    : ''
                }
              </div>
            </td></tr>`,
            )
            .join('')}
        </table>
      </td></tr>`,
    )
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:28px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:620px;margin:0 auto;background:#fff;border-radius:16px;border:1px solid #e5e7eb;overflow:hidden;">
    <tr><td style="padding:28px 28px 0;">
      <div style="font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#2563eb;">
        Resumen diario
      </div>
      <h1 style="margin:10px 0 6px;font-size:22px;line-height:1.3;color:#0f172a;">${escapeHtml(summary.headline)}</h1>
      <div style="font-size:13px;color:#6b7280;text-transform:capitalize;">${escapeHtml(longDate(date, timeZone))}</div>
      <div style="margin-top:14px;display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:600;">
        ${count} novedad${count === 1 ? '' : 'es'}
      </div>
    </td></tr>
    ${
      count
        ? sectionsHtml
        : `<tr><td style="padding:22px 28px;color:#6b7280;font-size:14px;">
             No se ha detectado ninguna novedad en las webs vigiladas.
           </td></tr>`
    }
    <tr><td style="padding:24px 28px 28px;">
      <a href="${escapeHtml(config.mail.appBaseUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 18px;border-radius:10px;">
        Abrir el panel
      </a>
      <div style="margin-top:20px;padding-top:16px;border-top:1px solid #eef0f3;color:#9ca3af;font-size:12px;">
        ${escapeHtml(config.brand.credit)}
      </div>
    </td></tr>
  </table></body></html>`;

  return { subject, text: textLines.join('\n'), html };
}
