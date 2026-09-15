/**
 * Applies the Postgres schema to any Postgres database (Supabase, Neon, RDS…).
 *
 *   DATABASE_URL=postgresql://... npm run migrate:pg
 *
 * On Netlify this is not needed: the platform applies the same files from
 * netlify/database/migrations/ before publishing a deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config, ROOT_DIR } from '../config/index.js';

const MIGRATIONS_DIR = path.join(ROOT_DIR, 'netlify', 'database', 'migrations');

const connectionString = config.db.connectionString;
if (!connectionString) {
  console.error('Falta DATABASE_URL (o NETLIFY_DATABASE_URL) en el entorno.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString,
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const { rows } = await client.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  const folders = fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let count = 0;
  for (const folder of folders) {
    if (applied.has(folder)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, folder, 'migration.sql'), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [folder]);
      await client.query('COMMIT');
      console.log(`[db] applied migration ${folder}`);
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log(count ? `[db] ${count} migration(s) applied` : '[db] schema up to date');
} finally {
  client.release();
  await pool.end();
}
