import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { getDb } from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Applies every .sql file in migrations/ exactly once, in name order.
 * Safe to call at every boot.
 *
 * Only used by the SQLite (local) setup: on Netlify the platform applies the
 * migrations in netlify/database/migrations/ before publishing a deploy.
 */
export async function runMigrations({ log = console.log } = {}) {
  if (config.db.driver !== 'sqlite') {
    log('[db] postgres: migrations are applied by the platform, skipping');
    return [];
  }

  const db = await getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const rows = await db.all('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.run('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
    });
    log(`[db] applied migration ${file}`);
  }
  if (!pending.length) log('[db] schema up to date');
  return pending;
}
