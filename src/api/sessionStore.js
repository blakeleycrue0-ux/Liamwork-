import session from 'express-session';
import { getDb } from '../db/index.js';

/**
 * Minimal SQLite-backed session store: sessions survive a server restart and
 * no extra dependency is needed.
 */
export class SqliteSessionStore extends session.Store {
  constructor() {
    super();
    this.db = getDb();
    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref?.();
  }

  cleanup() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    } catch {
      /* database closed */
    }
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (error) {
      return callback(error);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const ttl = sessionData?.cookie?.maxAge ?? 8 * 60 * 60 * 1000;
      this.db
        .prepare(
          `INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data`,
        )
        .run(sid, Date.now() + ttl, JSON.stringify(sessionData));
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }

  touch(sid, sessionData, callback) {
    return this.set(sid, sessionData, callback);
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return callback(null);
    } catch (error) {
      return callback(error);
    }
  }
}
