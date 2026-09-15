import type { Config } from '@netlify/functions';

// Serverless has no writable disk: Postgres, never SQLite. Set before the
// application modules are imported, because the configuration reads it on load.
process.env.DB_DRIVER ||= 'postgres';

/**
 * The scheduler on Netlify: there is no long-running process, so this runs
 * every minute and does exactly what one tick of src/scheduler does.
 *
 * Scheduled functions have a 30-second budget, so the batch is capped; websites
 * are checked least-recently-first, which means a capped run rolls over to the
 * next minute instead of starving anyone.
 *
 * Everything is imported lazily inside the handler so a load failure is logged
 * with its real reason instead of killing the invocation silently.
 */
const MAX_WEBSITES_PER_RUN = 25;

export default async (req: Request) => {
  const startedAt = Date.now();

  let nextRun: string | null = null;
  try {
    const body = (await req.json()) as { next_run?: string };
    nextRun = body?.next_run ?? null;
  } catch {
    nextRun = null;
  }

  try {
    const [bootstrap, crawler, settings, state] = await Promise.all([
      import('../../src/bootstrap.js'),
      import('../../src/crawler/index.js'),
      import('../../src/db/repositories/settings.repo.js'),
      import('../../src/db/repositories/crawlerState.repo.js'),
    ]);

    await bootstrap.ensureReady({ log: console.log });

    if (!(await settings.getBool('crawler_enabled', true))) {
      await state.updateState({ status: 'paused', last_heartbeat_at: new Date().toISOString() });
      console.log('[crawl] disabled from the dashboard, skipping');
      return;
    }

    await state.updateState({ status: 'running', last_heartbeat_at: new Date().toISOString() });

    const outcome = await crawler.runDueChecks({
      concurrency: await settings.getInt('crawler_concurrency', 8),
      limitWebsites: MAX_WEBSITES_PER_RUN,
    });

    await state.updateState({
      status: 'idle',
      last_run_at: new Date().toISOString(),
      last_run_duration_ms: Date.now() - startedAt,
      last_heartbeat_at: new Date().toISOString(),
      next_run_at: nextRun ?? new Date(Date.now() + 60_000).toISOString(),
    });

    console.log(
      `[crawl] ${outcome.checked} website(s), ${outcome.newItems} new item(s), ${outcome.failed} error(s) in ${
        Date.now() - startedAt
      }ms`,
    );
  } catch (error) {
    const details = error instanceof Error ? error : new Error(String(error));
    console.error('[crawl] failed:', details.stack ?? details.message);
  }
};

export const config: Config = {
  schedule: '* * * * *',
};
