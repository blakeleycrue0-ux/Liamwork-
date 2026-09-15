import type { Config } from '@netlify/functions';
import { ensureReady } from '../../src/bootstrap.js';
import { runDueChecks } from '../../src/crawler/index.js';
import { getBool, getInt } from '../../src/db/repositories/settings.repo.js';
import { updateState } from '../../src/db/repositories/crawlerState.repo.js';

/**
 * The scheduler on Netlify: there is no long-running process, so this runs
 * every minute and does exactly what one tick of src/scheduler does.
 *
 * Scheduled functions have a 30-second budget, so the batch is capped; websites
 * are checked least-recently-first, which means a capped run rolls over to the
 * next minute instead of starving anyone.
 */
const MAX_WEBSITES_PER_RUN = 25;

export default async (req: Request) => {
  const startedAt = Date.now();
  let nextRun: string | null = null;
  try {
    const { next_run } = (await req.json().catch(() => ({}))) as { next_run?: string };
    nextRun = next_run ?? null;
  } catch {
    nextRun = null;
  }

  await ensureReady({ log: console.log });

  if (!(await getBool('crawler_enabled', true))) {
    await updateState({ status: 'paused', last_heartbeat_at: new Date().toISOString() });
    console.log('[crawl] disabled from the dashboard, skipping');
    return;
  }

  await updateState({ status: 'running', last_heartbeat_at: new Date().toISOString() });

  const outcome = await runDueChecks({
    concurrency: await getInt('crawler_concurrency', 8),
    limitWebsites: MAX_WEBSITES_PER_RUN,
  });

  await updateState({
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
};

export const config: Config = {
  schedule: '* * * * *',
};
