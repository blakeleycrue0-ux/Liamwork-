import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * SQLite driver (local development). better-sqlite3 is synchronous; it is
 * wrapped in the same async interface as Postgres so repositories are written
 * once and run on both.
 */
export function createSqliteDriver({ file }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // WAL lets the web process and the crawler process work concurrently.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  return {
    dialect: 'sqlite',
    async all(sql, params = []) {
      return db.prepare(sql).all(params);
    },
    async get(sql, params = []) {
      return db.prepare(sql).get(params);
    },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
    },
    async exec(sql) {
      db.exec(sql);
    },
    /** Runs `fn` inside a transaction; `fn` receives this same driver. */
    async transaction(fn) {
      db.exec('BEGIN');
      try {
        const result = await fn(this);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      db.close();
    },
  };
}
