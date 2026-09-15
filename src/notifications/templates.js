import { config } from '../config/index.js';

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );

const formatDate = (iso) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' });
};

const FOOTER = 'Este mensaje ha sido generado automáticamente por Web Monitor.';

/**
 * One email per website and per check, listing every new publication found.
 */
export function buildUpdateEmail(website, posts) {
  const count = posts.length;
  const subject =
    count === 1
      ? `[Web Monitor] ${website.name}: ${posts[0].title}`.slice(0, 180)
      : `[Web Monitor] ${website.name}: ${count} nuevas publicaciones`;

  const textLines = [`Nueva actualización detectada`, `Web: ${website.name}`, ''];
  for (const post of posts) {
    textLines.push(`Título: ${post.title}`);
    const date = formatDate(post.published_at || post.first_seen_at);
    if (date) textLines.push(`Fecha: ${date}`);
    if (post.url) textLines.push(`Abrir publicación:`, post.url);
    textLines.push('');
  }
  textLines.push('---', FOOTER, config.mail.appBaseUrl);

  const itemsHtml = posts
    .map((post) => {
      const date = formatDate(post.published_at || post.first_seen_at);
      return `
      <tr><td style="padding:14px 0;border-bottom:1px solid #e6e8ec;">
        <div style="font-size:15px;font-weight:600;color:#111827;">${escapeHtml(post.title)}</div>
        ${date ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${escapeHtml(date)}</div>` : ''}
        ${
          post.url
            ? `<div style="margin-top:8px;"><a href="${escapeHtml(post.url)}" style="color:#2563eb;font-size:13px;">Abrir publicación</a></div>`
            : ''
        }
      </td></tr>`;
    })
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e6e8ec;">
    <tr><td style="padding:24px 24px 8px;">
      <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">Nueva actualización detectada</div>
      <h1 style="margin:8px 0 0;font-size:20px;color:#111827;">${escapeHtml(website.name)}</h1>
      <div style="font-size:13px;color:#6b7280;margin-top:4px;">${escapeHtml(website.url)}</div>
    </td></tr>
    <tr><td style="padding:0 24px;"><table role="presentation" width="100%">${itemsHtml}</table></td></tr>
    <tr><td style="padding:16px 24px 24px;color:#9ca3af;font-size:12px;">
      ${escapeHtml(FOOTER)}<br>
      <a href="${escapeHtml(config.mail.appBaseUrl)}" style="color:#9ca3af;">${escapeHtml(config.mail.appBaseUrl)}</a>
    </td></tr>
  </table></body></html>`;

  return { subject, text: textLines.join('\n'), html };
}

export function buildTestEmail() {
  const now = formatDate(new Date().toISOString());
  const text = [
    'Email de prueba de Web Monitor',
    '',
    `Si estás leyendo esto, la configuración SMTP funciona correctamente.`,
    `Fecha: ${now}`,
    '',
    '---',
    FOOTER,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e6e8ec;">
    <tr><td style="padding:24px;">
      <h1 style="margin:0;font-size:20px;color:#111827;">Email de prueba</h1>
      <p style="color:#374151;font-size:14px;">Si estás leyendo esto, la configuración SMTP de Web Monitor funciona correctamente.</p>
      <p style="color:#6b7280;font-size:13px;">Fecha: ${escapeHtml(now)}</p>
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;">${escapeHtml(FOOTER)}</p>
    </td></tr></table></body></html>`;
  return { subject: '[Web Monitor] Email de prueba', text, html };
}
