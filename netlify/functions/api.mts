import type { Config, Context } from '@netlify/functions';
import { createApp } from '../../src/api/server.js';
import { createRequestHandler } from '../../src/api/serverless.js';
import { ensureReady, readyError } from '../../src/bootstrap.js';

/**
 * The whole Express API as a single serverless function. The dashboard itself
 * (HTML/CSS/JS) is served statically from the CDN, so only /api/* and /health
 * reach this function.
 */
const handler = createRequestHandler(createApp());

export default async (request: Request, context: Context) => {
  // Seeding/migrations run once per cold start, but a database problem must not
  // take the whole API down: routes that do not touch the database (the auth
  // configuration, /health, /api/diagnostics) still answer, and the ones that
  // do report the real reason instead of a blank 500.
  await ensureReady({ log: console.log }).catch((error) => {
    console.error('[bootstrap] failed:', error.message);
  });
  if (readyError()) request.headers.set('x-web-monitor-bootstrap-error', readyError().message);
  return handler(request, context);
};

export const config: Config = {
  path: ['/api/*', '/health'],
};
