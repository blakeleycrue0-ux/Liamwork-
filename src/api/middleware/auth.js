import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { hashPassword, verifyPassword } from '../password.js';
import { bearerToken, verifyAccessToken } from '../auth/supabase.js';

export const isSupabaseAuth = () => config.auth.provider === 'supabase';
/** Open dashboard: no login at all. Anyone with the URL can use it. */
export const isOpenAccess = () => config.auth.provider === 'none';

let cachedHash = null;

/**
 * Resolves the admin password hash: ADMIN_PASSWORD_HASH when provided,
 * otherwise ADMIN_PASSWORD hashed in memory at boot (development only).
 */
export async function getAdminHash() {
  if (cachedHash) return cachedHash;
  if (config.auth.passwordHash) {
    cachedHash = config.auth.passwordHash;
  } else if (config.auth.password) {
    cachedHash = await hashPassword(config.auth.password);
    if (config.isProduction) {
      console.warn('[auth] ADMIN_PASSWORD used in production - set ADMIN_PASSWORD_HASH instead.');
    }
  } else {
    throw new Error('No admin credentials configured (ADMIN_PASSWORD_HASH or ADMIN_PASSWORD).');
  }
  return cachedHash;
}

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const entry = attempts.get(key);
  if (entry && entry.until > Date.now() && entry.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Demasiados intentos. Inténtalo de nuevo más tarde.' });
  }
  next();
}

export function recordLoginFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || entry.until < Date.now()) {
    attempts.set(ip, { count: 1, until: Date.now() + WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

export const clearLoginFailures = (ip) => attempts.delete(ip);

export async function checkCredentials(username, password) {
  const expectedUser = config.auth.username;
  const userOk =
    Buffer.byteLength(username ?? '') === Buffer.byteLength(expectedUser) &&
    crypto.timingSafeEqual(Buffer.from(username ?? ''), Buffer.from(expectedUser));
  const passOk = await verifyPassword(password ?? '', await getAdminHash());
  return userOk && passOk;
}

/**
 * Guards the API. With Supabase the credential is a bearer token verified on
 * every request; with the local provider it is the signed session cookie.
 * JSON 401 for API calls, redirect to the login page for page requests.
 */
export async function requireAuth(req, res, next) {
  if (isOpenAccess()) return next();

  // originalUrl, because this middleware is mounted under /api.
  const isApi = req.originalUrl.startsWith('/api/');

  if (isSupabaseAuth()) {
    const user = await verifyAccessToken(bearerToken(req));
    if (!user) {
      return isApi
        ? res.status(401).json({ error: 'No autenticado' })
        : res.redirect('/login');
    }
    req.user = user;
    return next();
  }

  if (req.session?.user) {
    req.user = req.session.user;
    return next();
  }
  return isApi ? res.status(401).json({ error: 'No autenticado' }) : res.redirect('/login');
}

/**
 * Double-submit CSRF token for state-changing requests.
 * Not needed with Supabase: the credential travels in a header, never as an
 * ambient cookie, so another origin cannot make the browser send it.
 */
export function csrfProtection(req, res, next) {
  if (isSupabaseAuth() || isOpenAccess()) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token');
  if (!req.session?.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ error: 'Token CSRF inválido' });
  }
  return next();
}

export const issueCsrfToken = (req) => {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  return req.session.csrfToken;
};
