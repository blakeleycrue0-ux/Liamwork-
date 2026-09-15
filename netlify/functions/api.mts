import type { Config, Context } from '@netlify/functions';
import { createApp } from '../../src/api/server.js';
import { createRequestHandler } from '../../src/api/serverless.js';
import { ensureReady } from '../../src/bootstrap.js';

/**
 * The whole Express API as a single serverless function. The dashboard itself
 * (HTML/CSS/JS) is served statically from the CDN, so only /api/* and /health
 * reach this function.
 */
const handler = createRequestHandler(createApp());

export default async (request: Request, context: Context) => {
  // Start migrations/seeding, but NEVER wait for them here: a database that
  // does not answer would burn the platform's 10-second budget and turn every
  // route into a blank 502, including the ones that need no database at all.
  // Routes that do need it wait behind their own gate, with a deadline.
  ensureReady({ log: console.log }).catch((error) => {
    console.error('[bootstrap] failed:', error.message);
  });
  return handler(request, context);
};

export const config: Config = {
  path: ['/api/*', '/health'],
};
