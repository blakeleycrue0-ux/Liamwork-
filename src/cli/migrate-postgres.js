/**
 * Applies the Postgres schema to the Supabase database.
 *
 *   DATABASE_URL=postgresql://... npm run migrate:pg
 *
 * Normally unnecessary: the app applies the same statements itself on the
 * first boot if the tables are missing. This is here for when you would
 * rather do it up front, or check what would run.
 */
import pg from 'pg';
import { config } from '../config/index.js';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from '../db/schema.postgres.js';

const connectionString = config.db.connectionString;
if (!connectionString) {
  console.error(
    'Falta DATABASE_URL. Cógela en Supabase: Project Settings -> Database -> ' +
      'Connection string -> Transaction pooler.',
  );
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
  await client.query('BEGIN');
  await client.query(POSTGRES_SCHEMA);
  await client.query(
    'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
    [POSTGRES_SCHEMA_NAME],
  );
  await client.query('COMMIT');
  console.log(`[db] esquema aplicado (${POSTGRES_SCHEMA_NAME})`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
