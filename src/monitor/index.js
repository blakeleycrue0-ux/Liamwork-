import { getAllSettings, getInt } from '../db/repositories/settings.repo.js';
import { updateState } from '../db/repositories/crawlerState.repo.js';
import { analyzeCandidates } from './analyze.js';
import { crawlAll, crawlWebsite } from './crawl.js';
import { reportStatus, sendDailyReport } from './report.js';
import { dateOf, dayWindow, previousDate, reportDue } from './window.js';

/**
 * The whole pipeline, in the order the architecture describes it:
 *
 *   27 webs -> crawl -> store -> Claude analyses -> changes -> one email
 *
 * Run twice a day. The crawl is cheap and does the filtering; Claude only
 * ever sees the pages whose text actually moved; the report goes out once,
 * in the morning, covering the previous calendar day.
 */

/**
 * The day a change belongs to.
 *
 * A change was observed somewhere between the previous look at the page and
 * this one, so it is dated by when that interval STARTED. This is what makes
 * the 07:00 run - which is comparing against last night - file its findings
 * under yesterday, where the morning report will find them, instead of under
 * today, where nobody would ever see them.
 */
export function changeDateFor(candidate, { timeZone, runAt }) {
  const anchor = candidate.observedSince || runAt;
  return dateOf(anchor, timeZone);
}

/**
 * One full pass: crawl everything, then analyse whatever moved.
 * Never throws; every failure is reported in the result instead.
 */
export async function runPipeline({
  limitWebsites = 0,
  maxPages,
  concurrency,
  now = new Date(),
  analyze = true,
  client,
} = {}) {
  const settings = await getAllSettings();
  const timeZone = settings.digest_timezone || 'Europe/Madrid';
  const runAt = now.toISOString();
  const startedAt = Date.now();

  await updateState({ status: 'running', last_heartbeat_at: runAt }).catch(() => {});

  const crawl = await crawlAll({ maxPages, concurrency, limitWebsites, at: runAt });

  // Group the candidates by the day they belong to, because a single run can
  // legitimately straddle two local days.
  const byDate = new Map();
  for (const candidate of crawl.candidates) {
    const date = changeDateFor(candidate, { timeZone, runAt });
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(candidate);
  }

  const analysis = { analyzed: 0, reported: 0, filtered: 0, skipped: 0, batches: 0, errors: [], usage: { input: 0, output: 0, cached: 0 } };

  if (analyze) {
    for (const [date, candidates] of byDate) {
      const outcome = await analyzeCandidates(candidates, {
        window: dayWindow(date, timeZone),
        changeDate: date,
        client,
      });
      analysis.analyzed += outcome.analyzed;
      analysis.reported += outcome.reported;
      // Cambios reales que el filtro de relevancia dejó fuera del informe.
      analysis.filtered += outcome.filtered ?? 0;
      analysis.skipped += outcome.skipped;
      analysis.batches += outcome.batches;
      analysis.errors.push(...outcome.errors);
      analysis.usage.input += outcome.usage.input;
      analysis.usage.output += outcome.usage.output;
      analysis.usage.cached += outcome.usage.cached;
    }
  }

  await updateState({
    status: 'idle',
    last_run_at: runAt,
    last_run_duration_ms: Date.now() - startedAt,
    last_heartbeat_at: new Date().toISOString(),
    next_run_at: null,
  }).catch(() => {});

  return {
    runAt,
    timeZone,
    durationMs: Date.now() - startedAt,
    crawl: {
      websites: crawl.websites,
      pagesChanged: crawl.changed,
      failed: crawl.failed,
      candidates: crawl.candidates.length,
    },
    dates: [...byDate.keys()],
    analysis,
    results: crawl.results,
  };
}

/**
 * What the scheduler calls: run the pipeline, then send the morning report
 * if its hour has passed and today's has not gone out yet.
 */
export async function runScheduledPass({ now = new Date(), limitWebsites = 0 } = {}) {
  const pipeline = await runPipeline({ now, limitWebsites });
  const status = await reportStatus(now);

  if (!status.due) return { pipeline, report: { sent: false, reason: 'not-due', ...status } };

  const report = await sendDailyReport({ now });
  return { pipeline, report };
}

export {
  analyzeCandidates,
  crawlAll,
  crawlWebsite,
  dayWindow,
  previousDate,
  reportDue,
  reportStatus,
  sendDailyReport,
  getInt,
};
