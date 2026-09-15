import { bool, getDb, num, nowIso } from '../index.js';

const parseSelectors = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

export const mapWebsite = (row) =>
  row && {
    ...row,
    active: bool(row.active),
    baseline_done: bool(row.baseline_done),
    check_interval: num(row.check_interval, 60),
    error_count: num(row.error_count),
    consecutive_errors: num(row.consecutive_errors),
    selector_config: parseSelectors(row.selector_config),
  };

export async function listWebsites({ activeOnly = false } = {}) {
  const db = await getDb();
  const sql = `SELECT * FROM websites ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY lower(name)`;
  return (await db.all(sql)).map(mapWebsite);
}

export async function getWebsite(id) {
  const db = await getDb();
  return mapWebsite(await db.get('SELECT * FROM websites WHERE id = ?', [id]));
}

export async function createWebsite(data) {
  const db = await getDb();
  const row = await db.get(
    `INSERT INTO websites (name, url, active, check_interval, detection_method, selector_config, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      data.name,
      data.url,
      data.active ? 1 : 0,
      data.check_interval,
      data.detection_method,
      JSON.stringify(data.selector_config ?? {}),
      data.notes ?? null,
    ],
  );
  return getWebsite(row.id);
}

export async function updateWebsite(id, data) {
  const db = await getDb();
  const current = await getWebsite(id);
  if (!current) return null;
  await db.run(
    `UPDATE websites SET
       name = ?, url = ?, active = ?, check_interval = ?, detection_method = ?,
       selector_config = ?, notes = ?, updated_at = ?
     WHERE id = ?`,
    [
      data.name ?? current.name,
      data.url ?? current.url,
      (data.active ?? current.active) ? 1 : 0,
      data.check_interval ?? current.check_interval,
      data.detection_method ?? current.detection_method,
      JSON.stringify(data.selector_config ?? current.selector_config ?? {}),
      data.notes === undefined ? current.notes : data.notes,
      nowIso(),
      id,
    ],
  );
  return getWebsite(id);
}

export async function deleteWebsite(id) {
  const db = await getDb();
  const { changes } = await db.run('DELETE FROM websites WHERE id = ?', [id]);
  return changes > 0;
}

export async function setActive(id, active) {
  const db = await getDb();
  await db.run('UPDATE websites SET active = ?, updated_at = ? WHERE id = ?', [
    active ? 1 : 0,
    nowIso(),
    id,
  ]);
  return getWebsite(id);
}

/** Marks a successful check; optionally records the newest detected item. */
export async function recordSuccess(id, { newestItem = null, at = nowIso() } = {}) {
  const db = await getDb();
  await db.run(
    `UPDATE websites SET
       last_checked_at = ?, last_success_at = ?, last_error = NULL,
       consecutive_errors = 0, baseline_done = 1,
       last_new_item_at = COALESCE(?, last_new_item_at),
       last_new_item_title = COALESCE(?, last_new_item_title),
       updated_at = ?
     WHERE id = ?`,
    [at, at, newestItem ? at : null, newestItem ? newestItem.title : null, at, id],
  );
}

export async function recordFailure(id, message, { at = nowIso() } = {}) {
  const db = await getDb();
  await db.run(
    `UPDATE websites SET
       last_checked_at = ?, last_error = ?, last_error_at = ?,
       error_count = error_count + 1, consecutive_errors = consecutive_errors + 1,
       updated_at = ?
     WHERE id = ?`,
    [at, String(message).slice(0, 1000), at, at, id],
  );
}

export async function countsByStatus() {
  const db = await getDb();
  const row = await db.get(
    `SELECT
       COUNT(*)                                            AS total,
       SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END)         AS active,
       SUM(CASE WHEN active = 1 AND consecutive_errors > 0 THEN 1 ELSE 0 END) AS failing
     FROM websites`,
  );
  const active = num(row?.active);
  const failing = num(row?.failing);
  return { total: num(row?.total), active, failing, ok: active - failing };
}
