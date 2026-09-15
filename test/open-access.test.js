import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/** Open dashboard: no login. This is what the deployed site runs. */
const cleanup = useTempDatabase('open-access');
process.env.AUTH_PROVIDER = 'none';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/api/server.js');
const { createRequestHandler } = await import('../src/api/serverless.js');

await runMigrations({ log: () => {} });
const handler = createRequestHandler(createApp());
const BASE = 'https://webcrawler0.netlify.app';

test.after(async () => {
  await closeDb();
  cleanup();
});

const call = (path, { method = 'GET', body } = {}) =>
  handler(
    new Request(BASE + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

test('the dashboard and its API work with no credentials', async () => {
  const shell = await call('/');
  assert.equal(shell.status, 200);

  const me = await call('/api/auth/me');
  assert.equal(me.status, 200);
  assert.equal((await me.json()).provider, 'none');

  const config = await call('/api/auth/config');
  assert.equal((await config.json()).provider, 'none');

  const websites = await call('/api/websites');
  assert.equal(websites.status, 200);

  const status = await call('/api/status');
  assert.equal(status.status, 200);
});

test('writes work without a CSRF token, since there is no session cookie', async () => {
  const created = await call('/api/workers', {
    method: 'POST',
    body: { name: 'Trabajador', email: 'trabajador@example.com' },
  });
  assert.equal(created.status, 201);

  const added = await call('/api/websites', {
    method: 'POST',
    body: { name: 'Otra web', url: 'https://example.org', check_interval: 120 },
  });
  assert.equal(added.status, 201);
});

test('there is no login page: /login lands on the dashboard', async () => {
  const response = await call('/login');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), '/');
});

test('diagnostics still reports a healthy deploy', async () => {
  const response = await call('/api/diagnostics');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.auth.provider, 'none');
});
