import { Router } from 'express';
import { config } from '../../config/index.js';
import {
  checkCredentials,
  clearLoginFailures,
  issueCsrfToken,
  loginRateLimit,
  recordLoginFailure,
} from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';

export const authRoutes = Router();

authRoutes.post(
  '/login',
  loginRateLimit,
  asyncHandler(async (req, res) => {
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
  req.session.destroy(() => {
    res.clearCookie('wm.sid');
    res.json({ ok: true });
  });
});

authRoutes.get('/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'No autenticado' });
  return res.json({ user: req.session.user, csrfToken: issueCsrfToken(req) });
});
