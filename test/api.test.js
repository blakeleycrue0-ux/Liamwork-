import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixtureSite, useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('api');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'secret-password';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/api/server.js');

await runMigrations({ log: () => {} });

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  cleanup();
});

/** Minimal cookie-jar client so the session survives between calls. */
const client = { cookie: '', csrf: null };
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(client.cookie ? { cookie: client.cookie } : {}),
      ...(client.csrf ? { 'x-csrf-token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length) client.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}

test('diagnostics is public and reports a healthy deploy', async () => {
  // Public on purpose: it is what you open when a deploy misbehaves, and it
  // carries no secrets and no data.
  const { status, data } = await call('/api/diagnostics');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.database.ok, true);
  assert.equal(data.startup_error, null);
  assert.equal('anon_key_configured' in data.auth, true);
  // Field names say whether a key is configured; the values never travel.
  assert.equal(JSON.stringify(data).includes('eyJ'), false, 'no key values, ever');
});

test('the API is protected until you log in', async () => {
  const anonymous = await call('/api/websites');
  assert.equal(anonymous.status, 401);

  // The dashboard shell is public (it holds no data); the API is what is guarded.
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(page.status, 200);

  const login = await fetch(`${base}/login`, { redirect: 'manual' });
  assert.equal(login.status, 301, 'there is no login page any more');
  assert.equal(login.headers.get('location'), '/');

  const wrong = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  assert.equal(wrong.status, 401);

  const ok = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'secret-password' } });
  assert.equal(ok.status, 200);
  client.csrf = ok.data.csrfToken;
  assert.ok(client.csrf, 'a CSRF token is issued on login');
});

test('state-changing requests require the CSRF token', async () => {
  const token = client.csrf;
  client.csrf = 'invalid';
  const rejected = await call('/api/workers', { method: 'POST', body: { name: 'X', email: 'x@example.com' } });
  assert.equal(rejected.status, 403);
  client.csrf = token;
});

test('websites can be added, edited, toggled and removed from the dashboard', async (t) => {
  const site = await startFixtureSite({ posts: [{ title: 'Publicacion de prueba del sitio', url: '/p1' }] });
  t.after(() => site.close());

  const created = await call('/api/websites', {
    method: 'POST',
    body: { name: 'FFSP', url: 'https://ffsp.info', check_interval: 60, detection_method: 'auto' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.website.name, 'FFSP');

  // A SECOND website, added without touching any code.
  const second = await call('/api/websites', {
    method: 'POST',
    body: {
      name: 'Segunda web',
      url: site.url,
      check_interval: 120,
      detection_method: 'html',
      selector_config: { list: 'article.post', title: 'h2 a', link: 'a', date: 'time' },
    },
  });
  assert.equal(second.status, 201);
  const secondId = second.data.website.id;
  assert.equal(second.data.website.selector_config.list, 'article.post');

  const list = await call('/api/websites');
  assert.equal(list.data.websites.length, 2);

  const edited = await call(`/api/websites/${secondId}`, { method: 'PUT', body: { check_interval: 300 } });
  assert.equal(edited.data.website.check_interval, 300);

  const toggled = await call(`/api/websites/${secondId}/toggle`, { method: 'POST', body: { active: false } });
  assert.equal(toggled.data.website.active, false);
  await call(`/api/websites/${secondId}/toggle`, { method: 'POST', body: { active: true } });

  // Manual check from the dashboard.
  const checked = await call(`/api/websites/${secondId}/check`, { method: 'POST' });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.result.ok, true);
  assert.ok(checked.data.website.last_checked_at);

  const history = await call(`/api/websites/${secondId}/posts`);
  assert.equal(history.data.posts.length, 1);

  const duplicateUrl = await call('/api/websites', { method: 'POST', body: { name: 'dup', url: 'https://ffsp.info' } });
  assert.equal(duplicateUrl.status, 409);

  const invalid = await call('/api/websites', { method: 'POST', body: { name: 'bad', url: 'not-a-url' } });
  assert.equal(invalid.status, 400);

  const removed = await call(`/api/websites/${secondId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.equal((await call('/api/websites')).data.websites.length, 1);
});

test('workers are managed from the dashboard and receive test emails', async () => {
  const first = await call('/api/workers', {
    method: 'POST',
    body: { name: 'Test Worker', email: 'cruecrv9445@gmail.com' },
  });
  assert.equal(first.status, 201);

  // A SECOND worker, added without touching any code.
  const second = await call('/api/workers', {
    method: 'POST',
    body: { name: 'Segundo Trabajador', email: 'segundo@example.com' },
  });
  assert.equal(second.status, 201);

  const badEmail = await call('/api/workers', { method: 'POST', body: { name: 'x', email: 'nope' } });
  assert.equal(badEmail.status, 400);

  const test1 = await call(`/api/workers/${first.data.worker.id}/test-email`, { method: 'POST' });
  assert.equal(test1.status, 200);
  assert.deepEqual(test1.data.recipients, ['cruecrv9445@gmail.com']);

  await call(`/api/workers/${second.data.worker.id}/toggle`, { method: 'POST', body: { active: false } });

  const testAll = await call('/api/workers/test-email', { method: 'POST' });
  assert.deepEqual(testAll.data.recipients, ['cruecrv9445@gmail.com'], 'only active workers are recipients');

  const settings = await call('/api/settings');
  assert.deepEqual(settings.data.recipients, ['cruecrv9445@gmail.com']);
});

test('status endpoint reports the dashboard summary', async () => {
  const { status, data } = await call('/api/status');
  assert.equal(status, 200);
  assert.equal(data.websites.total, 1);
  assert.equal(data.workers.active, 1);
  assert.ok('status' in data.crawler);
  assert.ok(Array.isArray(data.recent_posts));
});

test('settings are editable and validated', async () => {
  const saved = await call('/api/settings', { method: 'PUT', body: { default_check_interval: 120, crawler_enabled: true } });
  assert.equal(saved.data.settings.default_check_interval, '120');

  const invalid = await call('/api/settings', { method: 'PUT', body: { default_check_interval: 1 } });
  assert.equal(invalid.status, 400);
});

test('logout ends the session', async () => {
  const out = await call('/api/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  const after = await call('/api/websites');
  assert.equal(after.status, 401);
});
