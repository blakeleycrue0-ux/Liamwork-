import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import { config } from '../config/index.js';
import { DbSessionStore } from './sessionStore.js';
import { csrfProtection, isOpenAccess, isSupabaseAuth, requireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { waitForReady } from '../bootstrap.js';
import { authRoutes } from './routes/auth.routes.js';
import { diagnosticsRoutes } from './routes/diagnostics.routes.js';
import { websiteRoutes } from './routes/websites.routes.js';
import { workerRoutes } from './routes/workers.routes.js';
import { statusRoutes } from './routes/status.routes.js';
import { logRoutes, postRoutes, settingsRoutes } from './routes/misc.routes.js';
import { userRoutes } from './routes/users.routes.js';

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
      store: new DbSessionStore(),
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

  // There is no login page: /login only exists to catch old links and cached
  // scripts, and it sends you straight to the dashboard.
  app.get('/login', (req, res) => res.redirect(301, '/'));
  app.use('/api/auth', authRoutes);
  // Public on purpose: it is the first thing to look at when a deploy misbehaves.
  app.use('/api/diagnostics', diagnosticsRoutes);

  /**
   * Routes below need the database. They wait for the start-up sequence, but
   * with a deadline: an unreachable database becomes a 503 that says so,
   * instead of a request that hangs until the platform kills it with a 502.
   */
  const readyGate = async (req, res, next) => {
    try {
      await waitForReady({ timeoutMs: 6000 });
      return next();
    } catch (error) {
      return res.status(503).json({
        error: `${error.message}. Abre /api/diagnostics para ver el detalle.`,
      });
    }
  };

  // Everything below requires a session.
  app.use('/api', readyGate, requireAuth, csrfProtection);
  app.use('/api/websites', websiteRoutes);
  app.use('/api/workers', workerRoutes);
  app.use('/api/status', statusRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/users', userRoutes);

  // The dashboard shell carries no data, so it is always public - exactly how
  // Netlify serves it, straight from the CDN. Access control lives on /api.
  app.get('/', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
  app.use(express.static(WEB_DIR, { index: false }));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
