import { getDb, nowIso } from '../index.js';

const DEFAULTS = {
  default_check_interval: '60',
  scheduler_tick: '15',
  crawler_concurrency: '8',
  notify_on_first_check: 'false',
  max_items_per_email: '20',
  crawler_enabled: 'true',
  log_retention_days: '30',
  ai_recovery_enabled: 'false',
  ai_recovery_min_hours: '6',
  // 'digest' -> one summary a day; 'instant' -> an email per detection.
  notification_mode: 'digest',
  digest_hour: '20',
  digest_timezone: 'Europe/Madrid',
  digest_last_date: '',
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
