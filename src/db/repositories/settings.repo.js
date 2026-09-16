import { getDb, nowIso } from '../index.js';

const DEFAULTS = {
  default_check_interval: '600',
  scheduler_tick: '15',
  crawler_concurrency: '10',
  notify_on_first_check: 'false',
  max_items_per_email: '20',
  crawler_enabled: 'true',
  log_retention_days: '30',
  ai_recovery_enabled: 'false',
  ai_recovery_min_hours: '6',
  // 'digest' -> one summary a day; 'instant' -> an email per detection.
  notification_mode: 'digest',
  digest_hour: '7',
  digest_timezone: 'Europe/Madrid',
  digest_last_date: '',
  // Turn this off and the report is still sent, grouped by website, with no
  // model call at all: zero credits.
  digest_ai_enabled: 'true',

  // --- Monitoring v2 -------------------------------------------------------
  // How many pages of each website are fetched per pass. The listing plus its
  // most recent entries; going deeper costs time and finds nothing new.
  max_pages_per_website: '12',
  // The model that judges what changed. Switch to claude-haiku-4-5 to spend
  // roughly a fifth as much, at the cost of finer judgement.
  analysis_model: 'claude-opus-5',
  // Send the morning email even on a day when nothing changed, so silence is
  // never ambiguous. Turn it off to hear only when there is something.
  report_send_when_empty: 'true',
  // Keep LOW-priority changes out of the email. They stay in the dashboard.
  report_include_low: 'true',
};

/**
 * Settings are read on almost every crawler step, so they are cached for a few
 * seconds - important on serverless, where each call is a network round trip.
 */
let cache = { at: 0, values: null };
const CACHE_MS = 5000;

export async function getAllSettings({ fresh = false } = {}) {
  if (!fresh && cache.values && Date.now() - cache.at < CACHE_MS) return cache.values;
  const db = await getDb();
  const rows = await db.all('SELECT key, value FROM settings');
  const values = { ...DEFAULTS };
  for (const row of rows) values[row.key] = row.value;
  cache = { at: Date.now(), values };
  return values;
}

export async function getSetting(key, fallback = null) {
  const values = await getAllSettings();
  return values[key] ?? fallback;
}

export async function getBool(key, fallback = false) {
  const value = await getSetting(key, String(fallback));
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export async function getInt(key, fallback) {
  const parsed = Number.parseInt(await getSetting(key, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export async function setSettings(patch) {
  const db = await getDb();
  await db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(patch)) {
      await tx.run(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, String(value), nowIso()],
      );
    }
  });
  cache = { at: 0, values: null };
  return getAllSettings({ fresh: true });
}

export { DEFAULTS as SETTING_DEFAULTS };
