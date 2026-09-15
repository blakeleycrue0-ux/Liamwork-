import { listWorkers } from '../db/repositories/workers.repo.js';
import { markNotified, pendingNotification } from '../db/repositories/posts.repo.js';
import { getInt } from '../db/repositories/settings.repo.js';
import { sendMail } from './mailer.js';
import { buildTestEmail, buildUpdateEmail } from './templates.js';

/** Active workers are the single source of truth for recipients. */
export const activeRecipients = () => listWorkers({ activeOnly: true }).map((worker) => worker.email);

/**
 * Sends ONE grouped email per website for the posts that have not been
 * notified yet, then marks them as notified so they can never be sent twice.
 */
export async function notifyNewPosts(website, posts) {
  const items = posts?.length ? posts : pendingNotification(website.id);
  if (!items.length) return { sent: false, reason: 'no-new-posts', recipients: [] };

  const recipients = activeRecipients();
  if (!recipients.length) {
    return { sent: false, reason: 'no-active-workers', recipients: [], posts: items.length };
  }

  const limit = getInt('max_items_per_email', 20);
  const included = items.slice(0, limit);
  const { subject, text, html } = buildUpdateEmail(website, included);

  const info = await sendMail({ to: recipients, subject, text, html });
  // Mark every pending post, including any beyond the per-email limit, so a
  // very noisy site does not keep re-sending the same backlog.
  markNotified(items.map((post) => post.id));
  return { sent: true, recipients, posts: items.length, messageId: info.messageId };
}

export async function sendTestEmail(to) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : activeRecipients();
  if (!recipients.length) throw new Error('No hay trabajadores activos a los que enviar el email de prueba');
  const { subject, text, html } = buildTestEmail();
  const info = await sendMail({ to: recipients, subject, text, html });
  return { recipients, messageId: info.messageId, transport: info.transport };
}
