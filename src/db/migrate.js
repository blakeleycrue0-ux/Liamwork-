import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { getDb } from './index.js';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from './schema.postgres.js';
import {
  MONITOR_SCHEMA_NAME,
  MONITOR_SCHEMA_POSTGRES,
  MONITOR_SCHEMA_SQLITE,
  RELEVANCE_NAME,
  RELEVANCE_POSTGRES,
  REPORT_ATTEMPTS_NAME,
  REPORT_ATTEMPTS_POSTGRES,
} from './schema.monitor.js';

// NOT named __dirname: bundlers for serverless (Netlify) inject their own
// __dirname, and two declarations in the same scope are a SyntaxError that
// stops the whole function from loading.
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(moduleDir, 'migrations');

/**
 * Postgres (Supabase): applies the schema when the tables are not there yet,
 * so a fresh database comes up working instead of failing every request.
 * Everything is idempotent, so a boot against an already-migrated database
 * costs two cheap queries and does nothing.
 */
async function runPostgresMigrations({ log }) {
  const db = await getDb();
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const applied = [];
  const steps = [
    { name: POSTGRES_SCHEMA_NAME, sql: POSTGRES_SCHEMA, guard: 'public.websites' },
    { name: MONITOR_SCHEMA_NAME, sql: MONITOR_SCHEMA_POSTGRES, guard: 'public.pages' },
    { name: REPORT_ATTEMPTS_NAME, sql: REPORT_ATTEMPTS_POSTGRES, guard: 'public.report_attempts' },
    // Añade columnas a una tabla que ya existe, así que el guard sólo puede
    // comprobar la tabla. No importa: los ALTER llevan IF NOT EXISTS y el paso
    // queda anotado, de modo que correrlo dos veces no cuesta nada ni rompe.
    { name: RELEVANCE_NAME, sql: RELEVANCE_POSTGRES, guard: 'public.detected_changes' },
  ];

  for (const step of steps) {
    const recorded = await db.get('SELECT name FROM schema_migrations WHERE name = ?', [step.name]);
    const present = await db.get('SELECT to_regclass(?) IS NOT NULL AS present', [step.guard]);
    if (recorded && present?.present) continue;

    await db.exec(step.sql);
    await db.run('INSERT INTO schema_migrations (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [
      step.name,
    ]);
    log(`[db] applied migration ${step.name}`);
    applied.push(step.name);
  }

  if (!applied.length) log('[db] schema up to date');
  return applied;
}

/**
 * Applies every .sql file in migrations/ exactly once, in name order.
 * Safe to call at every boot.
 *
 * Only used by the SQLite (local) setup. On Postgres (Supabase) the schema is
 * a single idempotent block, applied by runPostgresMigrations above.
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
