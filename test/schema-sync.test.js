import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from '../src/db/schema.postgres.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('nothing depends on Netlify DB any more', () => {
  // The database is Supabase, reached through DATABASE_URL. Netlify's own
  // database extension used to provision one automatically, and that is
  // exactly what leaving these behind would silently bring back.
  assert.ok(!fs.existsSync(path.join(ROOT, 'netlify', 'database')), 'no Netlify DB migrations');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!pkg.dependencies['@netlify/database'], 'no @netlify/database dependency');

  const sources = ['src/config/index.js', 'src/db/drivers/postgres.driver.js'];
  for (const file of sources) {
    const body = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!body.includes('NETLIFY_DATABASE_URL'), `${file} reads DATABASE_URL only`);
    assert.ok(!body.includes('@netlify/database'), `${file} does not import Netlify DB`);
  }
  assert.equal(POSTGRES_SCHEMA_NAME, '001_init');
});

test('the Postgres and SQLite schemas declare the same tables', () => {
  const sqlite = fs.readFileSync(path.join(ROOT, 'src', 'db', 'migrations', '001_init.sql'), 'utf8');
  const tables = (sql) =>
    [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables(POSTGRES_SCHEMA), tables(sqlite));
});
