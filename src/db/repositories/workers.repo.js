import { bool, getDb, num, nowIso } from '../index.js';

const mapWorker = (row) => row && { ...row, active: bool(row.active) };

export async function listWorkers({ activeOnly = false } = {}) {
  const db = await getDb();
  const sql = `SELECT * FROM workers ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY lower(name)`;
  return (await db.all(sql)).map(mapWorker);
}

export async function getWorker(id) {
  const db = await getDb();
  return mapWorker(await db.get('SELECT * FROM workers WHERE id = ?', [id]));
}

export async function createWorker({ name, email, active = true }) {
  const db = await getDb();
  const row = await db.get(
    'INSERT INTO workers (name, email, active) VALUES (?, ?, ?) RETURNING id',
    [name, email, active ? 1 : 0],
  );
  return getWorker(row.id);
}

export async function updateWorker(id, data) {
  const db = await getDb();
  const current = await getWorker(id);
  if (!current) return null;
  await db.run('UPDATE workers SET name = ?, email = ?, active = ?, updated_at = ? WHERE id = ?', [
    data.name ?? current.name,
    data.email ?? current.email,
    (data.active ?? current.active) ? 1 : 0,
    nowIso(),
    id,
  ]);
  return getWorker(id);
}

export async function deleteWorker(id) {
  const db = await getDb();
  const { changes } = await db.run('DELETE FROM workers WHERE id = ?', [id]);
  return changes > 0;
}

export async function setActive(id, active) {
  const db = await getDb();
  await db.run('UPDATE workers SET active = ?, updated_at = ? WHERE id = ?', [
    active ? 1 : 0,
    nowIso(),
    id,
  ]);
  return getWorker(id);
}

export async function countWorkers() {
  const db = await getDb();
  const row = await db.get(
    'SELECT COUNT(*) AS total, SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active FROM workers',
  );
  return { total: num(row?.total), active: num(row?.active) };
}
