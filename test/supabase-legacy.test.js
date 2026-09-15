import assert from 'node:assert/strict';
import test from 'node:test';
import { SignJWT } from 'jose';
import { startFakeSupabase, useTempDatabase } from './helpers.js';

/**
 * Legacy Supabase projects (anon key signed HS256) keep the JWT secret private,
 * so tokens can only be checked by asking Supabase. This is the path used when
 * SUPABASE_JWT_SECRET is not configured.
 */
const cleanup = useTempDatabase('supabase-legacy');
const supabase = await startFakeSupabase();

process.env.AUTH_PROVIDER = 'supabase';
process.env.SUPABASE_URL = supabase.url;
process.env.SUPABASE_ANON_KEY = 'anon-key-for-tests';
delete process.env.SUPABASE_JWT_SECRET;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/api/server.js');
const { createRequestHandler } = await import('../src/api/serverless.js');
const { clearTokenCache } = await import('../src/api/auth/supabase.js');

await runMigrations({ log: () => {} });
const handler = createRequestHandler(createApp());

const token = await new SignJWT({ email: 'jefe@example.com', role: 'authenticated' })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject('user-uuid-1')
  .setAudience('authenticated')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode('a-secret-this-app-does-not-know'));

supabase.state.users[token] = { id: 'user-uuid-1', email: 'jefe@example.com', role: 'authenticated' };

test.after(async () => {
  await supabase.close();
  await closeDb();
  cleanup();
});

const call = (path, { token: bearer } = {}) =>
  handler(
    new Request(`https://web-monitor.example${path}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );

test('an HS256 token is accepted after Supabase vouches for it', async () => {
  clearTokenCache();
  const response = await call('/api/websites', { token });
  assert.equal(response.status, 200);

  const me = await call('/api/auth/me', { token });
  assert.deepEqual((await me.json()).user, {
    id: 'user-uuid-1',
    email: 'jefe@example.com',
    role: 'authenticated',
    provider: 'supabase',
  });
});

test('a token Supabase does not recognise is rejected', async () => {
  clearTokenCache();
  const stranger = await new SignJWT({ email: 'intruso@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('someone-else')
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode('another-secret'));

  assert.equal((await call('/api/websites', { token: stranger })).status, 401);
  assert.equal((await call('/api/websites', { token: 'garbage' })).status, 401);
});

test('verified tokens are cached instead of hitting Supabase on every poll', async () => {
  clearTokenCache();
  await call('/api/status', { token });
  const afterFirst = supabase.state.calls;

  for (let i = 0; i < 5; i += 1) await call('/api/status', { token });
  assert.equal(supabase.state.calls, afterFirst, 'the dashboard polls must not multiply auth calls');
});
