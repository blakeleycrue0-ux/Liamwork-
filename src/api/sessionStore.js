import session from 'express-session';
import { getDb } from '../db/index.js';

/**
 * Database-backed session store (SQLite locally, Postgres on Netlify):
 * sessions survive restarts and work across serverless invocations.
 */
export class DbSessionStore extends session.Store {
  constructor({ cleanupIntervalMs = 10 * 60 * 1000 } = {}) {
    super();
    if (cleanupIntervalMs) {
      const timer = setInterval(() => this.cleanup(), cleanupIntervalMs);
      timer.unref?.();
    }
  }

  async cleanup() {
    try {
      const db = await getDb();
      await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
    } catch {
      /* database closed or unreachable */
    }
  }

  get(sid, callback) {
    getDb()
      .then((db) => db.get('SELECT data, expires_at FROM sessions WHERE sid = ?', [sid]))
      .then((row) => {
        if (!row) return callback(null, null);
        if (Number(row.expires_at) < Date.now()) {
          this.destroy(sid, () => {});
          return callback(null, null);
        }
        return callback(null, typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
      })
      .catch(callback);
  }

  set(sid, sessionData, callback) {
    const ttl = sessionData?.cookie?.maxAge ?? 8 * 60 * 60 * 1000;
    getDb()
      .then((db) =>
        db.run(
          `INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)
           ON CONFLICT (sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data`,
          [sid, Date.now() + ttl, JSON.stringify(sessionData)],
        ),
      )
      .then(() => callback(null))
      .catch(callback);
  }

  touch(sid, sessionData, callback) {
    return this.set(sid, sessionData, callback);
  }

  destroy(sid, callback) {
    getDb()
      .then((db) => db.run('DELETE FROM sessions WHERE sid = ?', [sid]))
      .then(() => callback(null))
      .catch(callback);
  }
}
