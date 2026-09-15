import { bool, getDb, num, nowIso } from '../index.js';

export async function addLog({
  websiteId,
  success,
  newItems = 0,
  itemsFound = 0,
  method = null,
  durationMs = null,
  errorMessage = null,
}) {
  const db = await getDb();
  const row = await db.get(
    `INSERT INTO check_logs (website_id, checked_at, success, new_items, items_found, method, duration_ms, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      websiteId,
      nowIso(),
      success ? 1 : 0,
      newItems,
      itemsFound,
      method,
      durationMs,
      errorMessage ? String(errorMessage).slice(0, 1000) : null,
    ],
  );
  return row?.id;
}

export async function listLogs({ websiteId = null, onlyErrors = false, limit = 50 } = {}) {
  const db = await getDb();
  const where = [];
  const params = [];
  if (websiteId) {
    where.push('l.website_id = ?');
    params.push(websiteId);
  }
  if (onlyErrors) where.push('l.success = 0');
  params.push(limit);

  const rows = await db.all(
    `SELECT l.*, w.name AS website_name
     FROM check_logs l JOIN websites w ON w.id = l.website_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY l.checked_at DESC, l.id DESC LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    ...row,
    success: bool(row.success),
    new_items: num(row.new_items),
    items_found: num(row.items_found),
  }));
}

export async function lastCheckedAt() {
  const db = await getDb();
  const row = await db.get('SELECT MAX(checked_at) AS at FROM check_logs');
  return row?.at ?? null;
}

export async function countErrorsSince(sinceIso) {
  const db = await getDb();
  const row = await db.get(
    'SELECT COUNT(*) AS n FROM check_logs WHERE success = 0 AND checked_at >= ?',
    [sinceIso],
  );
  return num(row?.n);
}

export async function purgeOlderThan(sinceIso) {
  const db = await getDb();
  const { changes } = await db.run('DELETE FROM check_logs WHERE checked_at < ?', [sinceIso]);
  return changes;
}
