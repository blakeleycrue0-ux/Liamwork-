import { Router } from 'express';
import { config } from '../../config/index.js';
import { countsByStatus, listWebsites } from '../../db/repositories/websites.repo.js';
import { countWorkers } from '../../db/repositories/workers.repo.js';
import { countRecent, listPosts } from '../../db/repositories/posts.repo.js';
import { countErrorsSince, lastCheckedAt, listLogs } from '../../db/repositories/checkLogs.repo.js';
import { getState } from '../../db/repositories/crawlerState.repo.js';
import { getInt } from '../../db/repositories/settings.repo.js';
import { dueWebsites, runDueChecks } from '../../crawler/index.js';
import { asyncHandler } from '../middleware/errors.js';

export const statusRoutes = Router();

/** Everything the dashboard "Resumen" needs, in a single poll. */
statusRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [state, websites, workers, checkedAt, errors24h, new24h, new7d, recentPosts, recentErrors, tick, due] =
      await Promise.all([
        getState(),
        countsByStatus(),
        countWorkers(),
        lastCheckedAt(),
        countErrorsSince(since24h),
        countRecent(since24h),
        countRecent(since7d),
        listPosts({ limit: 8 }),
        listLogs({ onlyErrors: true, limit: 8 }),
        getInt('scheduler_tick', 15),
        dueWebsites(),
      ]);

    // The crawler is considered alive while its heartbeat is recent.
    const heartbeat = state.last_heartbeat_at ? new Date(state.last_heartbeat_at).getTime() : 0;
    const staleAfterMs = Math.max(90_000, tick * 3000);
    const alive = Date.now() - heartbeat < staleAfterMs;

    res.json({
      crawler: {
        status: alive ? state.status : 'stopped',
        alive,
        last_run_at: state.last_run_at,
        next_run_at: state.next_run_at,
        last_run_duration_ms: state.last_run_duration_ms,
        last_heartbeat_at: state.last_heartbeat_at,
        pid: state.pid,
        embedded: config.crawler.runInWeb,
        due_now: due.length,
      },
      websites,
      workers,
      checks: { last_checked_at: checkedAt, errors_24h: errors24h },
      posts: { new_24h: new24h, new_7d: new7d },
      recent_posts: recentPosts,
      recent_errors: recentErrors,
      mail: { transport: config.mail.transport, from: config.mail.from },
      server_time: new Date().toISOString(),
    });
  }),
);

/** Manual "check everything that is due right now". */
statusRoutes.post(
  '/run-now',
  asyncHandler(async (req, res) => {
    const outcome = await runDueChecks();
    res.json({ ok: true, ...outcome });
  }),
);

statusRoutes.get(
  '/websites-health',
  asyncHandler(async (req, res) => {
    const websites = await listWebsites();
    res.json({
      websites: websites.map((website) => ({
        id: website.id,
        name: website.name,
        active: website.active,
        last_checked_at: website.last_checked_at,
        consecutive_errors: website.consecutive_errors,
      })),
    });
  }),
);
