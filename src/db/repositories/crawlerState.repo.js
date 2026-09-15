import { getDb, num, nowIso } from '../index.js';

/** Shared crawler heartbeat: the dashboard reads it even when the scheduler
 *  runs in another process (or in a scheduled serverless function). */
export async function getState() {
  const db = await getDb();
  const row = await db.get('SELECT * FROM crawler_state WHERE id = 1');
  return row ? { ...row, pid: row.pid === null ? null : num(row.pid) } : { id: 1, status: 'stopped' };
}

export async function updateState(patch) {
  const db = await getDb();
  const current = await getState();
  const next = { ...current, ...patch, updated_at: nowIso() };
  await db.run(
    `UPDATE crawler_state SET status = ?, last_run_at = ?, last_run_duration_ms = ?,
       next_run_at = ?, last_heartbeat_at = ?, pid = ?, updated_at = ?
     WHERE id = 1`,
    [
      next.status ?? 'idle',
      next.last_run_at ?? null,
      next.last_run_duration_ms ?? null,
      next.next_run_at ?? null,
      next.last_heartbeat_at ?? null,
      next.pid ?? null,
      next.updated_at,
    ],
  );
  return getState();
}
