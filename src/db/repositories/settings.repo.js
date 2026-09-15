import { getDb, nowIso } from '../index.js';

const DEFAULTS = {
  default_check_interval: '60',
  scheduler_tick: '15',
  crawler_concurrency: '8',
  notify_on_first_check: 'false',
  max_items_per_email: '20',
  crawler_enabled: 'true',
  log_retention_days: '30',
};

export function getAllSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const values = { ...DEFAULTS };
  for (const row of rows) values[row.key] = row.value;
  return values;
}

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? fallback);
}

export const getBool = (key, fallback = false) => {
  const value = getSetting(key, String(fallback));
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const getInt = (key, fallback) => {
  const parsed = Number.parseInt(getSetting(key, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export function setSettings(patch) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((entries) => {
    for (const [key, value] of entries) stmt.run(key, String(value), nowIso());
  });
  tx(Object.entries(patch));
  return getAllSettings();
}

export { DEFAULTS as SETTING_DEFAULTS };
