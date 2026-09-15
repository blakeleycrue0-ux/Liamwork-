import { Router } from 'express';
import { config } from '../../config/index.js';
import { countsByStatus, listWebsites } from '../../db/repositories/websites.repo.js';
import { countWorkers } from '../../db/repositories/workers.repo.js';
import { countRecent, listPosts } from '../../db/repositories/posts.repo.js';
import { countErrorsSince, lastCheckedAt, listLogs } from '../../db/repositories/checkLogs.repo.js';
import { getState } from '../../db/repositories/crawlerState.repo.js';
import { getAllSettings } from '../../db/repositories/settings.repo.js';
import { dueWebsites, runDueChecks } from '../../crawler/index.js';
import { asyncHandler } from '../middleware/errors.js';

export const statusRoutes = Router();

/** Everything the dashboard "Resumen" needs, in a single poll. */
statusRoutes.get('/', (req, res) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const state = getState();

  // The crawler is considered alive when its heartbeat is recent.
  const heartbeat = state.last_heartbeat_at ? new Date(state.last_heartbeat_at).getTime() : 0;
  const staleAfterMs = Math.max(60_000, Number(getAllSettings().scheduler_tick) * 3000);
  const alive = Date.now() - heartbeat < staleAfterMs;

  res.json({
    crawler: {
      status: state.status === 'stopped' || !alive ? (alive ? state.status : 'stopped') : state.status,
      alive,
      last_run_at: state.last_run_at,
      next_run_at: state.next_run_at,
      last_run_duration_ms: state.last_run_duration_ms,
      last_heartbeat_at: state.last_heartbeat_at,
      pid: state.pid,
      embedded: config.crawler.runInWeb,
      due_now: dueWebsites().length,
    },
    websites: countsByStatus(),
    workers: countWorkers(),
    checks: {
      last_checked_at: lastCheckedAt(),
      errors_24h: countErrorsSince(since24h),
    },
    posts: {
      new_24h: countRecent(since24h),
      new_7d: countRecent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    },
    recent_posts: listPosts({ limit: 8 }),
    recent_errors: listLogs({ onlyErrors: true, limit: 8 }),
    mail: { transport: config.mail.transport, from: config.mail.from },
    server_time: new Date().toISOString(),
  });
});

/** Manual "check everything that is due right now". */
statusRoutes.post(
  '/run-now',
  asyncHandler(async (req, res) => {
    const outcome = await runDueChecks();
    res.json({ ok: true, ...outcome });
  }),
);

statusRoutes.get('/websites-health', (req, res) => {
  res.json({
    websites: listWebsites().map((website) => ({
      id: website.id,
      name: website.name,
      active: website.active,
      last_checked_at: website.last_checked_at,
      consecutive_errors: website.consecutive_errors,
    })),
  });
});
