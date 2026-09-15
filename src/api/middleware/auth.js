import crypto from 'node:crypto';
import { config } from '../../config/index.js';
import { hashPassword, verifyPassword } from '../password.js';

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

/** Guards the API: JSON 401 for XHR, redirect for page requests. */
export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  // originalUrl, because this middleware is mounted under /api.
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  return res.redirect('/login');
}

/** Double-submit CSRF token for state-changing requests. */
export function csrfProtection(req, res, next) {
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
