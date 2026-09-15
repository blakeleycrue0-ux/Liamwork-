import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from '../src/db/schema.postgres.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the Netlify migration file and the embedded schema are identical', () => {
  const file = path.join(ROOT, 'netlify', 'database', 'migrations', POSTGRES_SCHEMA_NAME, 'migration.sql');
  assert.equal(fs.readFileSync(file, 'utf8'), POSTGRES_SCHEMA);
});

test('the Postgres and SQLite schemas declare the same tables', () => {
  const sqlite = fs.readFileSync(path.join(ROOT, 'src', 'db', 'migrations', '001_init.sql'), 'utf8');
  const tables = (sql) =>
    [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables(POSTGRES_SCHEMA), tables(sqlite));
});
