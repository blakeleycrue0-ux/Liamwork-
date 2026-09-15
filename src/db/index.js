import { config } from '../config/index.js';

let driverPromise = null;

async function createDriver() {
  if (config.db.driver === 'postgres') {
    const { createPostgresDriver } = await import('./drivers/postgres.driver.js');
    return createPostgresDriver({ connectionString: config.db.connectionString });
  }
  // Non-literal specifier on purpose: esbuild (Netlify) must not follow this
  // import, or the native SQLite binding ends up in the serverless bundle and
  // the function dies on start-up with "Cannot find package 'better-sqlite3'".
  // Nothing evaluates it unless the SQLite driver is actually in use.
  const sqliteDriver = './drivers/sqlite.driver.js';
  const { createSqliteDriver } = await import(sqliteDriver);
  return createSqliteDriver({ file: config.db.file });
}

/**
 * Returns the shared database driver. Both drivers expose the same async
 * interface (`all`, `get`, `run`, `exec`, `transaction`), so repositories and
 * everything above them are dialect-agnostic.
 */
export function getDb() {
  if (!driverPromise) driverPromise = createDriver();
  return driverPromise;
}

export async function closeDb() {
  if (!driverPromise) return;
  const db = await driverPromise;
  driverPromise = null;
  await db.close();
}

export const isPostgres = () => config.db.driver === 'postgres';
export const nowIso = () => new Date().toISOString();

/** COUNT()/SUM() come back as strings on Postgres; normalise to numbers. */
export const num = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Booleans are stored as 0/1 integers in both dialects. */
export const bool = (value) => value === 1 || value === true || value === '1';
