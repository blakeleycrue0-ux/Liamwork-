/**
 * Postgres driver. The database is Supabase, reached through DATABASE_URL.
 *
 * Repositories write SQL with `?` placeholders; they are translated to $1..$n
 * here so a single set of queries serves both dialects.
 */
const toPgPlaceholders = (sql) => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};

export async function createPostgresDriver({ connectionString }) {
  if (!connectionString) {
    throw new Error(
      'Falta DATABASE_URL. Es la cadena de conexión de Supabase ' +
        '(Project Settings -> Database -> Connection string -> Transaction pooler).',
    );
  }

  const pg = await import('pg');
  const pool = new pg.default.Pool({
    connectionString,
    // Supabase terminates TLS at the pooler with its own certificate chain;
    // the connection is encrypted, the chain is simply not one we pin.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    // The transaction pooler hands out a connection per statement, so a small
    // pool is the right size here and keeps well inside Supabase's limits.
    max: 5,
    // Serverless has a hard request budget: a database that does not answer
    // must fail quickly instead of hanging until the platform times out.
    connectionTimeoutMillis: 6000,
    idleTimeoutMillis: 10_000,
    query_timeout: 8000,
    statement_timeout: 8000,
  });

  // A pool that throws on an idle client would take the whole process with it.
  pool.on('error', (error) => console.error('[db] idle client error:', error.message));

  const query = async (client, sql, params) => client.query(toPgPlaceholders(sql), params);

  const wrap = (client) => ({
    dialect: 'postgres',
    async all(sql, params = []) {
      return (await query(client, sql, params)).rows;
    },
    async get(sql, params = []) {
      return (await query(client, sql, params)).rows[0];
    },
    async run(sql, params = []) {
      const result = await query(client, sql, params);
      return { changes: result.rowCount, lastInsertRowid: result.rows?.[0]?.id };
    },
    async exec(sql) {
      await client.query(sql);
    },
    async transaction(fn) {
      const connection = await pool.connect();
      const scoped = wrap(connection);
      try {
        await connection.query('BEGIN');
        const result = await fn(scoped);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        connection.release();
      }
    },
    async close() {
      if (client === pool) await pool.end();
    },
  });

  return wrap(pool);
}
