import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT } from 'jose';
import { useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('supabase-auth');
// Supabase mode: tokens are verified locally with the project's JWT secret,
// so the whole flow can be exercised without touching the network.
const JWT_SECRET = 'test-supabase-jwt-secret-value-0123456789';
process.env.AUTH_PROVIDER = 'supabase';
process.env.SUPABASE_URL = 'https://example-project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'anon-key-for-tests';
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/api/server.js');
const { createRequestHandler } = await import('../src/api/serverless.js');

await runMigrations({ log: () => {} });
const handler = createRequestHandler(createApp());
const BASE = 'https://web-monitor.example';

test.after(async () => {
  await closeDb();
  cleanup();
});

const signToken = ({ sub = 'user-uuid-1', email = 'jefe@example.com', expiresIn = '1h', secret = JWT_SECRET } = {}) =>
  new SignJWT({ email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));

const call = (path, { method = 'GET', body, token } = {}) =>
  handler(
    new Request(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

test('the login page is told to use Supabase, with the public anon key only', async () => {
  const response = await call('/api/auth/config');
  const data = await response.json();
  assert.equal(data.provider, 'supabase');
  assert.equal(data.supabase.url, 'https://example-project.supabase.co');
  assert.equal(data.supabase.anonKey, 'anon-key-for-tests');
  assert.equal('serviceKey' in data.supabase, false, 'the service-role key must never be exposed');
});

test('the dashboard shell is public in bearer mode, the API is not', async () => {
  // A plain navigation carries no Authorization header, so guarding the HTML
  // would bounce the browser to /login forever. The shell holds no data.
  const shell = await call('/');
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /WebMonitor/);

  assert.equal((await call('/api/status')).status, 401);
});

test('a valid Supabase token grants access to the API', async () => {
  const token = await signToken();
  const response = await call('/api/websites', { token });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).websites, []);

  const me = await call('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), {
    user: { id: 'user-uuid-1', email: 'jefe@example.com', role: 'authenticated', provider: 'supabase' },
    provider: 'supabase',
  });
});

test('missing, forged and expired tokens are rejected', async () => {
  assert.equal((await call('/api/websites')).status, 401);
  assert.equal((await call('/api/websites', { token: 'not-a-jwt' })).status, 401);

  const forged = await signToken({ secret: 'another-projects-secret-0123456789' });
  assert.equal((await call('/api/websites', { token: forged })).status, 401);

  const expired = await signToken({ expiresIn: '-1m' });
  assert.equal((await call('/api/websites', { token: expired })).status, 401);
});

test('writes need no CSRF token in bearer mode, but still need a valid token', async () => {
  const token = await signToken();
  const created = await call('/api/workers', {
    method: 'POST',
    token,
    body: { name: 'Trabajador', email: 'trabajador@example.com' },
  });
  assert.equal(created.status, 201, 'a bearer request carries no ambient cookie, so CSRF does not apply');

  const anonymous = await call('/api/workers', {
    method: 'POST',
    body: { name: 'Intruso', email: 'intruso@example.com' },
  });
  assert.equal(anonymous.status, 401);
});

test('user management requires the service-role key to be configured', async () => {
  const token = await signToken();
  const response = await call('/api/users', { token });
  // No SUPABASE_SERVICE_ROLE_KEY in this test environment.
  assert.equal(response.status, 501);
  assert.match((await response.json()).error, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('the local password login is disabled while Supabase is the provider', async () => {
  const response = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'whatever' },
  });
  assert.equal(response.status, 400);
});
