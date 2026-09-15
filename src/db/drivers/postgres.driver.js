/**
 * Postgres driver (Netlify DB / Neon, or any Postgres via DATABASE_URL).
 *
 * Repositories write SQL with `?` placeholders; they are translated to $1..$n
 * here so a single set of queries serves both dialects.
 */
const toPgPlaceholders = (sql) => {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
};

export async function createPostgresDriver({ connectionString }) {
  let pool;
  if (connectionString) {
    const pg = await import('pg');
    pool = new pg.default.Pool({
      connectionString,
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 5,
      // Serverless has a hard request budget: a database that does not answer
      // must fail quickly instead of hanging until the platform times out.
      connectionTimeoutMillis: 6000,
      idleTimeoutMillis: 10_000,
      query_timeout: 8000,
      statement_timeout: 8000,
    });
  } else {
    // On Netlify the connection string is provisioned automatically.
    const { getDatabase } = await import('@netlify/database');
    pool = getDatabase().pool;
  }

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
