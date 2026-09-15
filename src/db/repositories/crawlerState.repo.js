import { getDb, nowIso } from '../index.js';

/** Shared crawler heartbeat, readable by the web process even when the
 *  scheduler runs as a separate process. */
export function getState() {
  const row = getDb().prepare('SELECT * FROM crawler_state WHERE id = 1').get();
  return row ?? { id: 1, status: 'stopped' };
}

export function updateState(patch) {
  const current = getState();
  const next = { ...current, ...patch, updated_at: nowIso() };
  getDb()
    .prepare(
      `UPDATE crawler_state SET status = @status, last_run_at = @last_run_at,
         last_run_duration_ms = @last_run_duration_ms, next_run_at = @next_run_at,
         last_heartbeat_at = @last_heartbeat_at, pid = @pid, updated_at = @updated_at
       WHERE id = 1`,
    )
    .run({
      status: next.status ?? 'idle',
      last_run_at: next.last_run_at ?? null,
      last_run_duration_ms: next.last_run_duration_ms ?? null,
      next_run_at: next.next_run_at ?? null,
      last_heartbeat_at: next.last_heartbeat_at ?? null,
      pid: next.pid ?? null,
      updated_at: next.updated_at,
    });
  return getState();
}
