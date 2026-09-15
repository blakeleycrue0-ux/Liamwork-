import { getDb, nowIso } from '../index.js';

const mapWorker = (row) => row && { ...row, active: Boolean(row.active) };

export function listWorkers({ activeOnly = false } = {}) {
  const sql = activeOnly
    ? 'SELECT * FROM workers WHERE active = 1 ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM workers ORDER BY name COLLATE NOCASE';
  return getDb().prepare(sql).all().map(mapWorker);
}

export function getWorker(id) {
  return mapWorker(getDb().prepare('SELECT * FROM workers WHERE id = ?').get(id));
}

export function createWorker({ name, email, active = true }) {
  const info = getDb()
    .prepare('INSERT INTO workers (name, email, active) VALUES (?, ?, ?)')
    .run(name, email, active ? 1 : 0);
  return getWorker(info.lastInsertRowid);
}

export function updateWorker(id, data) {
  const current = getWorker(id);
  if (!current) return null;
  getDb()
    .prepare('UPDATE workers SET name = ?, email = ?, active = ?, updated_at = ? WHERE id = ?')
    .run(
      data.name ?? current.name,
      data.email ?? current.email,
      (data.active ?? current.active) ? 1 : 0,
      nowIso(),
      id,
    );
  return getWorker(id);
}

export function deleteWorker(id) {
  return getDb().prepare('DELETE FROM workers WHERE id = ?').run(id).changes > 0;
}

export function setActive(id, active) {
  getDb()
    .prepare('UPDATE workers SET active = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, nowIso(), id);
  return getWorker(id);
}

export function countWorkers() {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active FROM workers')
    .get();
  return { total: row.total ?? 0, active: row.active ?? 0 };
}
