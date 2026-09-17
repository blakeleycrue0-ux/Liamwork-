import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixtureSite, useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('api');
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'secret-password';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/api/server.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');

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

test('the watched list is code-managed: no adding or removing over the API', async () => {
  // src/config/sites.js is the only place a site is added or dropped. These
  // endpoints used to exist and must stay gone, because the dashboard is open.
  const created = await call('/api/websites', {
    method: 'POST',
    body: { name: 'Intruso', url: 'https://intruso.example', check_interval: 60 },
  });
  assert.equal(created.status, 404, 'there is no way to create a website over the API');

  const imported = await call('/api/websites/import', { method: 'POST', body: { text: 'X\nhttps://x.example' } });
  assert.equal(imported.status, 404, 'the bulk importer is gone too');

  const seeded = await createWebsite({
    name: 'FFSP',
    url: 'https://ffsp.info',
    active: true,
    check_interval: 60,
    detection_method: 'auto',
    selector_config: {},
  });
  const removed = await call(`/api/websites/${seeded.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 404, 'and nothing can delete a website either');
  assert.equal((await call('/api/websites')).data.websites.length, 1);
});

test('a watched website can be checked, edited and toggled from the dashboard', async (t) => {
  const site = await startFixtureSite({ posts: [{ title: 'Publicacion de prueba del sitio', url: '/p1' }] });
  t.after(() => site.close());

  // Published the way the real ones are: from code, at boot.
  const second = await createWebsite({
    name: 'Segunda web',
    url: site.url,
    active: true,
    check_interval: 120,
    detection_method: 'html',
    selector_config: { list: 'article.post', title: 'h2 a', link: 'a', date: 'time' },
  });
  const secondId = second.id;

  const list = await call('/api/websites');
  assert.equal(list.data.websites.length, 2);

  // How a site is read stays editable: that is maintenance, not curation.
  const edited = await call(`/api/websites/${secondId}`, { method: 'PUT', body: { check_interval: 300 } });
  assert.equal(edited.data.website.check_interval, 300);
  assert.equal(edited.data.website.selector_config.list, 'article.post');

  const toggled = await call(`/api/websites/${secondId}/toggle`, { method: 'POST', body: { active: false } });
  assert.equal(toggled.data.website.active, false);
  await call(`/api/websites/${secondId}/toggle`, { method: 'POST', body: { active: true } });

  // Manual check from the dashboard.
  const checked = await call(`/api/websites/${secondId}/check`, { method: 'POST' });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.result.ok, true);
  assert.ok(checked.data.website.last_checked_at);

  // The history of a website is now its tracked pages and detected changes.
  const history = await call(`/api/websites/${secondId}/posts`);
  assert.ok(Array.isArray(history.data.changes), 'detected changes are listed');
  assert.ok(history.data.pages.length >= 1, 'and so are the pages being tracked');

  const invalid = await call(`/api/websites/${secondId}`, { method: 'PUT', body: { url: 'not-a-url' } });
  assert.equal(invalid.status, 400);
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
  assert.equal(data.websites.total, 2);
  assert.equal(data.workers.active, 1);
  assert.ok('status' in data.crawler);
  assert.ok(Array.isArray(data.recent_changes));
  assert.ok('covers_date' in data.report, 'the summary says which day the next report covers');
  assert.ok('analyses' in data.usage_7d, 'and how much work the analysis has done this week');

  // Lo que el panel NO recibe. Un código HTTP, un recuento de tokens o el
  // nombre del transporte de correo no le sirven a quien vigila clubes de
  // golf, y sí le sirven a quien quiera sondear la instalación. El detalle
  // técnico vive en /api/websites/:id/diagnostics, tras la misma
  // autenticación, no en la carga que pinta el Resumen.
  const json = JSON.stringify(data);
  assert.ok(!('recent_errors' in data), 'sin lista de errores en crudo');
  assert.ok(!('input_tokens' in data.usage_7d), 'sin recuento de tokens');
  assert.ok(!('transport' in data.mail), 'sin nombre del transporte de correo');
  assert.ok(!/ENOTFOUND|HTTP \d{3}|smtp|nodemailer/i.test(json), 'sin rastros de infraestructura');
});

test('la lista de webs traduce el fallo y no publica el mensaje interno', async () => {
  const { data } = await call('/api/websites');
  for (const website of data.websites) {
    assert.ok(!('last_error' in website), 'el mensaje del crawler no sale al panel');
    assert.ok('failing' in website, 'pero sí si la web está fallando');
    if (website.status) {
      assert.ok(website.status.label, 'y en qué se traduce');
      assert.doesNotMatch(website.status.label, /HTTP|ENOTFOUND|DNS|TLS/, 'en castellano llano');
    }
  }
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
