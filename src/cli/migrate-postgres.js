/**
 * Applies the Postgres schema to any Postgres database (Supabase, Neon, RDS…).
 *
 *   DATABASE_URL=postgresql://... npm run migrate:pg
 *
 * On Netlify this is not needed: the platform applies the same schema from
 * netlify/database/migrations/ before publishing a deploy, and the app checks
 * it again on start-up.
 */
import pg from 'pg';
import { config } from '../config/index.js';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from '../db/schema.postgres.js';

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
