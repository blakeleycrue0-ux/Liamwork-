import { getAllSettings, getSetting, setSettings } from '../db/repositories/settings.repo.js';
import { markNotified, pendingForDigest } from '../db/repositories/posts.repo.js';
import { activeRecipients } from './notifier.js';
import { sendMail } from './mailer.js';
import { buildDigestEmail } from './digest.template.js';
import { summariseDigest } from './digest.ai.js';

/** The calendar date and hour where the user actually lives. */
export function localParts(timeZone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  };
}

/**
 * The daily summary is due once the configured hour has passed and nothing has
 * been sent for today yet. Checked every minute by the scheduler, so a missed
 * window (a sleeping site, a failed run) still goes out later the same day.
 */
export async function digestDue(now = new Date()) {
  const settings = await getAllSettings();
  if (settings.notification_mode !== 'digest') return false;

  const { date, hour } = localParts(settings.digest_timezone || 'Europe/Madrid', now);
  if (hour < Number(settings.digest_hour ?? 20)) return false;
  return settings.digest_last_date !== date;
}

/**
 * Builds and sends the daily summary: everything detected since the last one,
 * grouped into sections by Claude, in one email per day.
 */
export async function sendDigest({ force = false, now = new Date() } = {}) {
  const settings = await getAllSettings();
  const timeZone = settings.digest_timezone || 'Europe/Madrid';
  const { date } = localParts(timeZone, now);

  const posts = await pendingForDigest();
  if (!posts.length && !force) {
    await setSettings({ digest_last_date: date });
    return { sent: false, reason: 'no-news', date };
  }

  const recipients = await activeRecipients();
  if (!recipients.length) return { sent: false, reason: 'no-active-workers', posts: posts.length };

  const summary = await summariseDigest(posts, { timeZone, date });
  const { subject, text, html } = buildDigestEmail({ summary, posts, date, timeZone });

  const info = await sendMail({ to: recipients, subject, text, html });
  await markNotified(posts.map((post) => post.id));
  await setSettings({ digest_last_date: date });

  return {
    sent: true,
    date,
    posts: posts.length,
    sections: summary.sections.length,
    recipients,
    ai: summary.generatedByAi,
    messageId: info.messageId,
  };
}

/** Shown in the dashboard so the next summary is never a mystery. */
export async function digestStatus(now = new Date()) {
  const settings = await getAllSettings();
  const timeZone = settings.digest_timezone || 'Europe/Madrid';
  const hour = Number(settings.digest_hour ?? 20);
  const { date } = localParts(timeZone, now);
  const pending = await pendingForDigest();

  return {
    mode: settings.notification_mode,
    hour,
    timezone: timeZone,
    last_sent_date: (await getSetting('digest_last_date', '')) || null,
    sent_today: settings.digest_last_date === date,
    pending_items: pending.length,
  };
}
