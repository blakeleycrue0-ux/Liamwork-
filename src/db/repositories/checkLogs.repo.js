import { getDb, nowIso } from '../index.js';

export function addLog({
  websiteId,
  success,
  newItems = 0,
  itemsFound = 0,
  method = null,
  durationMs = null,
  errorMessage = null,
}) {
  const info = getDb()
    .prepare(
      `INSERT INTO check_logs (website_id, checked_at, success, new_items, items_found, method, duration_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      websiteId,
      nowIso(),
      success ? 1 : 0,
      newItems,
      itemsFound,
      method,
      durationMs,
      errorMessage ? String(errorMessage).slice(0, 1000) : null,
    );
  return info.lastInsertRowid;
}

export function listLogs({ websiteId = null, onlyErrors = false, limit = 50 } = {}) {
  const where = [];
  if (websiteId) where.push('l.website_id = @websiteId');
  if (onlyErrors) where.push('l.success = 0');
  const sql = `SELECT l.*, w.name AS website_name
               FROM check_logs l JOIN websites w ON w.id = l.website_id
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY l.checked_at DESC, l.id DESC LIMIT @limit`;
  return getDb()
    .prepare(sql)
    .all({ websiteId, limit })
    .map((row) => ({ ...row, success: Boolean(row.success) }));
}

export function lastCheckedAt() {
  return getDb().prepare('SELECT MAX(checked_at) AS at FROM check_logs').get().at;
}

export function countErrorsSince(sinceIso) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM check_logs WHERE success = 0 AND checked_at >= ?')
    .get(sinceIso).n;
}

export function purgeOlderThan(sinceIso) {
  return getDb().prepare('DELETE FROM check_logs WHERE checked_at < ?').run(sinceIso).changes;
}
