import { createRemoteJWKSet, jwtVerify } from 'jose';
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

/** @returns {Promise<{id, email, role}|null>} the authenticated user, or null */
export async function verifyAccessToken(token) {
  if (!token) return null;
  const options = { audience: 'authenticated' };
  try {
    const { payload } = config.supabase.jwtSecret
      ? await jwtVerify(token, new TextEncoder().encode(config.supabase.jwtSecret), options)
      : await jwtVerify(token, getJwks(), options);
    if (!payload.sub) return null;
    return {
      id: payload.sub,
      email: payload.email ?? null,
      role: payload.role ?? 'authenticated',
      provider: 'supabase',
    };
  } catch {
    return null;
  }
}

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
