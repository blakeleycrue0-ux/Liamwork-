import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { POSTGRES_SCHEMA, POSTGRES_SCHEMA_NAME } from '../src/db/schema.postgres.js';
import {
  MONITOR_SCHEMA_NAME,
  MONITOR_SCHEMA_POSTGRES,
  MONITOR_SCHEMA_SQLITE,
} from '../src/db/schema.monitor.js';

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

test('the monitoring schema is the same on SQLite and on Supabase', () => {
  // The SQLite migration file is generated from the constant; if they drift,
  // local development and production stop agreeing about what a table is.
  const file = fs.readFileSync(path.join(ROOT, 'src', 'db', 'migrations', '003_monitor_v2.sql'), 'utf8');
  assert.equal(file, MONITOR_SCHEMA_SQLITE.trimStart());

  const tables = (sql) =>
    [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(tables(MONITOR_SCHEMA_POSTGRES), tables(MONITOR_SCHEMA_SQLITE));
  assert.deepEqual(tables(MONITOR_SCHEMA_POSTGRES), [
    'daily_reports',
    'detected_changes',
    'page_versions',
    'pages',
  ]);
  assert.equal(MONITOR_SCHEMA_NAME, '003_monitor_v2');
});

test('the retired pipeline is gone, not merely unused', () => {
  // Two code paths that can both send email is how a rebuild ends up still
  // sending the thing it replaced.
  for (const file of [
    'src/crawler/index.js',
    'src/crawler/detector.js',
    'src/notifications/digest.js',
    'src/notifications/digest.ai.js',
    'src/db/repositories/posts.repo.js',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, file)), `${file} should not exist`);
  }
  const notifier = fs.readFileSync(path.join(ROOT, 'src', 'notifications', 'notifier.js'), 'utf8');
  assert.ok(!notifier.includes('notifyNewPosts'), 'there is no per-detection email any more');
});
