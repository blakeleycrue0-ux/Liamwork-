import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/index.js';

let db = null;

/** Lazily open (and reuse) the SQLite connection. */
export function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.db.file), { recursive: true });
  db = new Database(config.db.file);
  // WAL lets the web process and the crawler process work concurrently.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

export const nowIso = () => new Date().toISOString();
