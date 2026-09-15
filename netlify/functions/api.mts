import type { Config, Context } from '@netlify/functions';

/**
 * The whole Express API as a single serverless function.
 *
 * Everything is loaded lazily inside the handler and wrapped in a try/catch on
 * purpose: if the application fails to load (a missing module, a bad import, a
 * broken dependency), the platform would otherwise answer a blank 502 with the
 * reason buried in the logs. This way the browser gets the actual error.
 */
type Handler = (request: Request, context?: unknown) => Promise<Response>;

let handlerPromise: Promise<Handler> | null = null;

async function loadHandler(): Promise<Handler> {
  const [server, serverless, bootstrap] = await Promise.all([
    import('../../src/api/server.js'),
    import('../../src/api/serverless.js'),
    import('../../src/bootstrap.js'),
  ]);

  // Migrations and seeding start here but are never awaited: waiting for a
  // database that does not answer would burn the platform's request budget.
  bootstrap.ensureReady({ log: console.log }).catch((error: Error) => {
    console.error('[bootstrap] failed:', error.message);
  });

  return serverless.createRequestHandler(server.createApp());
}

export default async (request: Request, context: Context) => {
  try {
    if (!handlerPromise) handlerPromise = loadHandler();
    const handler = await handlerPromise;
    return await handler(request, context);
  } catch (error) {
    handlerPromise = null;
    const details = error instanceof Error ? error : new Error(String(error));
    console.error('[function] failed:', details.stack ?? details.message);
    return new Response(
      JSON.stringify(
        {
          error: 'La función no pudo arrancar',
          message: details.message,
          where: String(details.stack ?? '').split('\n').slice(1, 5).join(' | '),
        },
        null,
        2,
      ),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
};

export const config: Config = {
  path: ['/api/*', '/health'],
};
