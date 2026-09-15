import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { getDb } from './index.js';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from './schema.postgres.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Postgres: the schema is normally applied by the platform (Netlify DB) or by
 * `npm run migrate:pg`. This runs the same statements as a safety net, so a
 * database that was never migrated still comes up with its tables instead of
 * failing every request. Everything is idempotent.
 */
async function runPostgresMigrations({ log }) {
  const db = await getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const existing = await db.get('SELECT name FROM schema_migrations WHERE name = ?', [
    POSTGRES_SCHEMA_NAME,
  ]);
  const tableExists = await db.get(
    "SELECT to_regclass('public.websites') IS NOT NULL AS present",
  );
  if (existing && tableExists?.present) {
    log('[db] schema up to date');
    return [];
  }

  await db.exec(POSTGRES_SCHEMA);
  await db.run(
    'INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING',
    [POSTGRES_SCHEMA_NAME],
  );
  log(`[db] applied migration ${POSTGRES_SCHEMA_NAME}`);
  return [POSTGRES_SCHEMA_NAME];
}

/**
 * Applies every .sql file in migrations/ exactly once, in name order.
 * Safe to call at every boot.
 *
 * Only used by the SQLite (local) setup: on Netlify the platform applies the
 * migrations in netlify/database/migrations/ before publishing a deploy.
 */
export async function runMigrations({ log = console.log } = {}) {
  if (config.db.driver !== 'sqlite') return runPostgresMigrations({ log });

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
