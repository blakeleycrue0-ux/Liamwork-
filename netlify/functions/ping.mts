import type { Config } from '@netlify/functions';

/**
 * Zero-dependency probe. If /ping answers but /api/* does not, the problem is
 * in the application bundle; if neither answers, it is the site's function
 * setup. Costs nothing and saves a lot of guessing.
 */
export default async () =>
  new Response(JSON.stringify({ ok: true, runtime: process.version, at: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json' },
  });

export const config: Config = {
  path: '/ping',
};
