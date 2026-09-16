import { listWorkers } from '../db/repositories/workers.repo.js';
import { sendMail } from './mailer.js';
import { buildTestEmail } from './templates.js';

/**
 * Who receives email, and the one-off test message.
 *
 * There is deliberately no "send an email for this detection" function any
 * more. Exactly one email leaves this system per day, and it is built in
 * src/monitor/report.js. Keeping a second path alive is how a rebuild ends up
 * still sending the thing it was supposed to stop sending.
 */

/** Active workers are the single source of truth for recipients. */
export async function activeRecipients() {
  const workers = await listWorkers({ activeOnly: true });
  return workers.map((worker) => worker.email);
}

export async function sendTestEmail(to) {
  const recipients = to ? (Array.isArray(to) ? to : [to]) : await activeRecipients();
  if (!recipients.length) throw new Error('No hay trabajadores activos a los que enviar el email de prueba');
  const { subject, text, html } = buildTestEmail();
  const info = await sendMail({ to: recipients, subject, text, html });
  return { recipients, messageId: info.messageId, transport: info.transport };
}
