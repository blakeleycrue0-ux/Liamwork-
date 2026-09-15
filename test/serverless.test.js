import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('serverless');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'serverless-password';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/api/server.js');
const { createRequestHandler } = await import('../src/api/serverless.js');
const workers = await import('../src/db/repositories/workers.repo.js');

await runMigrations({ log: () => {} });
await workers.createWorker({ name: 'Test Worker', email: 'worker@example.com', active: true });

// Exactly what netlify/functions/api.mts does per cold start.
const handler = createRequestHandler(createApp());
const BASE = 'https://web-monitor.netlify.app';

test.after(async () => {
  await closeDb();
  cleanup();
});

const call = (path, { method = 'GET', body, cookie, csrf } = {}) =>
  handler(
    new Request(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-nf-client-connection-ip': '203.0.113.9',
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

test('the function serves the API over web Request/Response', async () => {
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const anonymous = await call('/api/websites');
  assert.equal(anonymous.status, 401);
});

test('login works through the adapter and returns a session cookie', async (t) => {
  const bad = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'wrong' },
  });
  assert.equal(bad.status, 401);

  const response = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'serverless-password' },
  });
  assert.equal(response.status, 200);

  const setCookie = response.headers.getSetCookie();
  assert.ok(setCookie.length, 'Set-Cookie must survive the multiValueHeaders bridge');
  const cookie = setCookie.map((value) => value.split(';')[0]).join('; ');
  const { csrfToken } = await response.json();
  assert.ok(csrfToken);

  // The session cookie is accepted on the next invocation (new "cold" request).
  const websites = await call('/api/websites', { cookie });
  assert.equal(websites.status, 200);
  assert.deepEqual((await websites.json()).websites, []);

  // CSRF is still enforced through the adapter.
  const noCsrf = await call('/api/workers', {
    method: 'POST',
    cookie,
    body: { name: 'X', email: 'x@example.com' },
  });
  assert.equal(noCsrf.status, 403);

  const created = await call('/api/workers', {
    method: 'POST',
    cookie,
    csrf: csrfToken,
    body: { name: 'Segundo', email: 'segundo@example.com' },
  });
  assert.equal(created.status, 201);

  // Query strings and JSON bodies survive the event conversion.
  const posts = await call('/api/posts?limit=5', { cookie });
  assert.equal(posts.status, 200);
  assert.deepEqual((await posts.json()).posts, []);

  const status = await call('/api/status', { cookie });
  const summary = await status.json();
  assert.equal(summary.workers.active, 2);
  assert.equal(summary.crawler.status, 'stopped');
});
