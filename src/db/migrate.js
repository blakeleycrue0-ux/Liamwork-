import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Applies every .sql file in migrations/ exactly once, in name order.
 * Safe to call at every boot.
 */
export function runMigrations({ log = console.log } = {}) {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((row) => row.name),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();

  const pending = files.filter((f) => !applied.has(f));
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(file);
    });
    apply();
    log(`[db] applied migration ${file}`);
  }
  if (!pending.length) log('[db] schema up to date');
  return pending;
}
