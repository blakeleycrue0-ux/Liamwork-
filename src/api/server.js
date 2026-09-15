import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { config } from '../config/index.js';
import { SqliteSessionStore } from './sessionStore.js';
import { csrfProtection, requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { authRoutes } from './routes/auth.routes.js';
import { websiteRoutes } from './routes/websites.routes.js';
import { workerRoutes } from './routes/workers.routes.js';
import { statusRoutes } from './routes/status.routes.js';
import { logRoutes, postRoutes, settingsRoutes } from './routes/misc.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '..', 'web');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.use(
    session({
      name: 'wm.sid',
      secret: config.auth.sessionSecret || 'insecure-dev-secret-change-me',
      store: new SqliteSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.auth.secureCookies,
        maxAge: config.auth.sessionTtl * 1000,
      },
    }),
  );

  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // Public: login page + login endpoint.
  app.get('/login', (req, res) => {
    if (req.session?.user) return res.redirect('/');
    return res.sendFile(path.join(WEB_DIR, 'login.html'));
  });
  app.use('/api/auth', authRoutes);

  // Everything below requires a session.
  app.use('/api', requireAuth, csrfProtection);
  app.use('/api/websites', websiteRoutes);
  app.use('/api/workers', workerRoutes);
  app.use('/api/status', statusRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/settings', settingsRoutes);

  app.get('/', requireAuth, (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
  app.use(express.static(WEB_DIR, { index: false }));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
