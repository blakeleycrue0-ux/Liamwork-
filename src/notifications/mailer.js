import nodemailer from 'nodemailer';
import { config } from '../config/index.js';

let transporter = null;

/**
 * Builds the transport declared in MAIL_TRANSPORT.
 *  - smtp    : real SMTP server (credentials come from environment variables)
 *  - console : prints the message to stdout (development, no credentials needed)
 */
export function getTransporter() {
  if (transporter) return transporter;

  if (config.mail.transport === 'smtp') {
    const { host, port, secure, user, password } = config.mail.smtp;
    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: user ? { user, pass: password } : undefined,
    });
  } else {
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

export function resetTransporter() {
  transporter = null;
}

export async function sendMail({ to, subject, text, html }) {
  if (!to || (Array.isArray(to) && !to.length)) {
    throw new Error('No active recipients configured');
  }
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const info = await getTransporter().sendMail({
    from: config.mail.from,
    to: recipients,
    subject,
    text,
    html,
  });

  if (config.mail.transport !== 'smtp') {
    console.log(`\n[mail:console] To: ${recipients}\n[mail:console] Subject: ${subject}\n${text}\n`);
  }
  return { messageId: info.messageId, accepted: info.accepted ?? recipients, transport: config.mail.transport };
}

/** Used by the dashboard to validate SMTP configuration. */
export async function verifyTransport() {
  if (config.mail.transport !== 'smtp') return { ok: true, transport: config.mail.transport };
  await getTransporter().verify();
  return { ok: true, transport: 'smtp' };
}
