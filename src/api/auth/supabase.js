import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { config } from '../../config/index.js';

/**
 * Supabase Auth integration.
 *
 * The browser signs in against Supabase directly (with the public anon key) and
 * sends the resulting JWT as `Authorization: Bearer ...`. This module only
 * verifies those tokens and, with the service-role key, manages users.
 *
 * Bearer tokens instead of cookies also mean no CSRF surface and no session
 * table - a better fit for serverless than server-side sessions.
 */
let jwks = null;

const getJwks = () => {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
};

const toUser = (payload) => ({
  id: payload.sub ?? payload.id,
  email: payload.email ?? null,
  role: payload.role ?? 'authenticated',
  provider: 'supabase',
});

/**
 * Last resort when the token cannot be verified locally: ask Supabase who the
 * token belongs to. Legacy projects sign with HS256 and keep the secret
 * private, so without SUPABASE_JWT_SECRET this is the only way - and it works
 * with nothing but the project URL and the public anon key.
 */
async function introspect(token) {
  const response = await fetch(`${config.supabase.url}/auth/v1/user`, {
    headers: { apikey: config.supabase.anonKey, authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user?.id ? toUser(user) : null;
}

/**
 * Verified tokens are cached briefly: the dashboard polls every few seconds and
 * introspection is a network round trip. Never longer than the token itself.
 */
const verified = new Map();
const CACHE_MS = 60_000;

const cacheGet = (token) => {
  const hit = verified.get(token);
  if (!hit) return null;
  if (hit.until < Date.now()) {
    verified.delete(token);
    return null;
  }
  return hit.user;
};

const cacheSet = (token, user, expSeconds) => {
  if (verified.size > 500) verified.clear();
  const until = Math.min(Date.now() + CACHE_MS, expSeconds ? expSeconds * 1000 : Infinity);
  if (until > Date.now()) verified.set(token, { user, until });
};

/** @returns {Promise<{id, email, role}|null>} the authenticated user, or null */
export async function verifyAccessToken(token) {
  if (!token) return null;

  const cached = cacheGet(token);
  if (cached) return cached;

  const options = { audience: 'authenticated' };
  let algorithm = null;
  try {
    algorithm = decodeProtectedHeader(token).alg ?? null;
  } catch {
    return null; // not even a JWT
  }

  // 1. Shared secret (legacy projects): fastest, no network.
  if (config.supabase.jwtSecret) {
    try {
      const { payload } = await jwtVerify(
        token,
        new TextEncoder().encode(config.supabase.jwtSecret),
        options,
      );
      if (!payload.sub) return null;
      const user = toUser(payload);
      cacheSet(token, user, payload.exp);
      return user;
    } catch {
      return null;
    }
  }

  // 2. Asymmetric signing keys: verify against the project's JWKS.
  if (algorithm && !algorithm.startsWith('HS')) {
    try {
      const { payload } = await jwtVerify(token, getJwks(), options);
      if (!payload.sub) return null;
      const user = toUser(payload);
      cacheSet(token, user, payload.exp);
      return user;
    } catch {
      return null;
    }
  }

  // 3. HS256 without the secret: only Supabase can vouch for this token.
  try {
    const user = await introspect(token);
    if (user) cacheSet(token, user, null);
    return user;
  } catch {
    return null;
  }
}

/** Test seam: the cache is process-wide. */
export const clearTokenCache = () => verified.clear();

export const bearerToken = (req) => {
  const header = req.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
};

/* ------------------------------------------------------------------ admin -- */

const adminFetch = async (path, init = {}) => {
  if (!config.supabase.serviceKey) {
    const error = new Error(
      'Gestionar usuarios requiere SUPABASE_SERVICE_ROLE_KEY en las variables de entorno',
    );
    error.status = 501;
    throw error;
  }
  const response = await fetch(`${config.supabase.url}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: config.supabase.serviceKey,
      authorization: `Bearer ${config.supabase.serviceKey}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.msg || body.message || body.error_description || `Supabase ${response.status}`);
    error.status = response.status === 404 ? 404 : 400;
    throw error;
  }
  return body;
};

const mapUser = (user) => ({
  id: user.id,
  email: user.email,
  created_at: user.created_at,
  last_sign_in_at: user.last_sign_in_at,
  confirmed: Boolean(user.email_confirmed_at || user.confirmed_at),
  banned_until: user.banned_until ?? null,
});

export async function listUsers({ perPage = 100 } = {}) {
  const body = await adminFetch(`/admin/users?per_page=${perPage}`);
  return (body.users ?? []).map(mapUser);
}

export async function createUser({ email, password }) {
  const user = await adminFetch('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  return mapUser(user);
}

export async function updateUserPassword(id, password) {
  const user = await adminFetch(`/admin/users/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  });
  return mapUser(user);
}

export async function deleteUser(id) {
  await adminFetch(`/admin/users/${id}`, { method: 'DELETE' });
  return true;
}
