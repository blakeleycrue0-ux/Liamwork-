import type { Config, Context } from '@netlify/functions';
import { createApp } from '../../src/api/server.js';
import { createRequestHandler } from '../../src/api/serverless.js';
import { ensureReady } from '../../src/bootstrap.js';

/**
 * The whole Express API as a single serverless function. The dashboard itself
 * (HTML/CSS/JS) is served statically from the CDN, so only /api/* and /health
 * reach this function.
 */
let handlerPromise: Promise<(request: Request, context?: unknown) => Promise<Response>> | null = null;

const getHandler = () => {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      // Seeds the initial website/worker once per cold start. Schema migrations
      // are applied by Netlify DB before the deploy is published.
      await ensureReady({ log: console.log });
      return createRequestHandler(createApp());
    })().catch((error) => {
      handlerPromise = null;
      throw error;
    });
  }
  return handlerPromise;
};

export default async (request: Request, context: Context) => {
  const handler = await getHandler();
  return handler(request, context);
};

export const config: Config = {
  path: ['/api/*', '/health'],
};
