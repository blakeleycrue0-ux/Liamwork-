import { Router } from 'express';
import { config } from '../../config/index.js';
import {
  checkCredentials,
  clearLoginFailures,
  isSupabaseAuth,
  issueCsrfToken,
  loginRateLimit,
  recordLoginFailure,
} from '../middleware/auth.js';
import { bearerToken, verifyAccessToken } from '../auth/supabase.js';
import { asyncHandler } from '../middleware/errors.js';

export const authRoutes = Router();

/** Tells the login page which provider to use. The anon key is public by design. */
authRoutes.get('/config', (req, res) => {
  res.json({
    provider: config.auth.provider,
    supabase: isSupabaseAuth()
      ? { url: config.supabase.url, anonKey: config.supabase.anonKey }
      : null,
  });
});

authRoutes.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
    if (isSupabaseAuth()) {
      // The browser signs in against Supabase directly and sends the token back
      // on every request; there is nothing to do here.
      return res.status(400).json({ error: 'Este despliegue usa Supabase Auth' });
    }
    const { username, password } = req.body ?? {};
    const ok = await checkCredentials(username, password);
    if (!ok) {
      recordLoginFailure(req.ip);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    clearLoginFailures(req.ip);
    return req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'No se pudo iniciar sesión' });
      req.session.user = { username: config.auth.username };
      const csrfToken = issueCsrfToken(req);
      return req.session.save(() => res.json({ ok: true, user: req.session.user, csrfToken }));
    });
  }),
);

authRoutes.post('/logout', (req, res) => {
  if (isSupabaseAuth()) return res.json({ ok: true });
  return req.session.destroy(() => {
    res.clearCookie('wm.sid');
    res.json({ ok: true });
  });
});

authRoutes.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (isSupabaseAuth()) {
      const user = await verifyAccessToken(bearerToken(req));
      if (!user) return res.status(401).json({ error: 'No autenticado' });
      return res.json({ user, provider: 'supabase' });
    }
    if (!req.session?.user) return res.status(401).json({ error: 'No autenticado' });
    return res.json({ user: req.session.user, provider: 'local', csrfToken: issueCsrfToken(req) });
  }),
);
