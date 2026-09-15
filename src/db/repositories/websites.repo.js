import { getDb, nowIso } from '../index.js';

const parseSelectors = (raw) => {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};

export const mapWebsite = (row) =>
  row && {
    ...row,
    active: Boolean(row.active),
    baseline_done: Boolean(row.baseline_done),
    selector_config: parseSelectors(row.selector_config),
  };

export function listWebsites({ activeOnly = false } = {}) {
  const db = getDb();
  const sql = activeOnly
    ? 'SELECT * FROM websites WHERE active = 1 ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM websites ORDER BY name COLLATE NOCASE';
  return db.prepare(sql).all().map(mapWebsite);
}

export function getWebsite(id) {
  return mapWebsite(getDb().prepare('SELECT * FROM websites WHERE id = ?').get(id));
}

export function createWebsite(data) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO websites (name, url, active, check_interval, detection_method, selector_config, notes)
       VALUES (@name, @url, @active, @check_interval, @detection_method, @selector_config, @notes)`,
    )
    .run({
      name: data.name,
      url: data.url,
      active: data.active ? 1 : 0,
      check_interval: data.check_interval,
      detection_method: data.detection_method,
      selector_config: JSON.stringify(data.selector_config ?? {}),
      notes: data.notes ?? null,
    });
  return getWebsite(info.lastInsertRowid);
}

export function updateWebsite(id, data) {
  const db = getDb();
  const current = getWebsite(id);
  if (!current) return null;
  db.prepare(
    `UPDATE websites SET
       name = @name, url = @url, active = @active, check_interval = @check_interval,
       detection_method = @detection_method, selector_config = @selector_config,
       notes = @notes, updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id,
    name: data.name ?? current.name,
    url: data.url ?? current.url,
    active: (data.active ?? current.active) ? 1 : 0,
    check_interval: data.check_interval ?? current.check_interval,
    detection_method: data.detection_method ?? current.detection_method,
    selector_config: JSON.stringify(data.selector_config ?? current.selector_config ?? {}),
    notes: data.notes === undefined ? current.notes : data.notes,
    updated_at: nowIso(),
  });
  return getWebsite(id);
}

export function deleteWebsite(id) {
  return getDb().prepare('DELETE FROM websites WHERE id = ?').run(id).changes > 0;
}

export function setActive(id, active) {
  getDb()
    .prepare('UPDATE websites SET active = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, nowIso(), id);
  return getWebsite(id);
}

/** Marks a successful check; optionally records the newest detected item. */
export function recordSuccess(id, { newestItem = null, at = nowIso() } = {}) {
  const db = getDb();
  db.prepare(
    `UPDATE websites SET
       last_checked_at = @at, last_success_at = @at, last_error = NULL,
       consecutive_errors = 0, baseline_done = 1,
       last_new_item_at = COALESCE(@newAt, last_new_item_at),
       last_new_item_title = COALESCE(@newTitle, last_new_item_title),
       updated_at = @at
     WHERE id = @id`,
  ).run({
    id,
    at,
    newAt: newestItem ? at : null,
    newTitle: newestItem ? newestItem.title : null,
  });
}

export function recordFailure(id, message, { at = nowIso() } = {}) {
  getDb()
    .prepare(
      `UPDATE websites SET
         last_checked_at = @at, last_error = @message, last_error_at = @at,
         error_count = error_count + 1, consecutive_errors = consecutive_errors + 1,
         updated_at = @at
       WHERE id = @id`,
    )
    .run({ id, at, message: String(message).slice(0, 1000) });
}

export function countsByStatus() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                            AS total,
         SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END)         AS active,
         SUM(CASE WHEN active = 1 AND consecutive_errors > 0 THEN 1 ELSE 0 END) AS failing
       FROM websites`,
    )
    .get();
  const active = row.active ?? 0;
  const failing = row.failing ?? 0;
  return { total: row.total ?? 0, active, failing, ok: active - failing };
}
