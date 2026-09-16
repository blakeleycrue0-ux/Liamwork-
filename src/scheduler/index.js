import { purgeOlderThan } from '../db/repositories/checkLogs.repo.js';
import { getBool, getInt } from '../db/repositories/settings.repo.js';
import { updateState } from '../db/repositories/crawlerState.repo.js';
import { runDueChecks } from '../crawler/index.js';
import { digestDue, sendDigest } from '../notifications/digest.js';

/**
 * Periodic driver for the crawler. It wakes up every `scheduler_tick` seconds,
 * asks the crawler which websites are due and runs them. It can live inside the
 * web server process or in a dedicated process (`npm run crawler`).
 */
export class Scheduler {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.cachedTick = 15;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.lastCleanup = 0;
  }

  /** Cached so the timer can stay synchronous; refreshed on every tick. */
  get tickSeconds() {
    return Math.max(5, this.cachedTick ?? 15);
  }

  async refreshTick() {
    this.cachedTick = await getInt('scheduler_tick', 15);
    return this.tickSeconds;
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.refreshTick()
      .then(() =>
        updateState({
          status: 'idle',
          pid: process.pid,
          last_heartbeat_at: new Date().toISOString(),
          next_run_at: new Date(Date.now() + this.tickSeconds * 1000).toISOString(),
        }),
      )
      .catch((error) => this.log(`[scheduler] ${error.message}`));
    this.log(`[scheduler] started (pid ${process.pid})`);
    this.scheduleNext(0);
    return this;
  }

  scheduleNext(delayMs = this.tickSeconds * 1000) {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.tick().catch((error) => this.log(`[scheduler] ${error.message}`)), delayMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async tick() {
    if (this.stopped || this.running) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.refreshTick();
      if (!(await getBool('crawler_enabled', true))) {
        await updateState({ status: 'paused', last_heartbeat_at: new Date().toISOString() });
        return;
      }
      await updateState({
        status: 'running',
        last_heartbeat_at: new Date().toISOString(),
        pid: process.pid,
      });
      const outcome = await runDueChecks();
      if (outcome.checked) {
        this.log(
          `[scheduler] checked ${outcome.checked} website(s), ${outcome.newItems} new item(s), ${outcome.failed} error(s)`,
        );
      }
      await this.maybeDigest();
      await this.maybeCleanup();
      await updateState({
        status: 'idle',
        last_run_at: new Date().toISOString(),
        last_run_duration_ms: Date.now() - startedAt,
        last_heartbeat_at: new Date().toISOString(),
        next_run_at: new Date(Date.now() + this.tickSeconds * 1000).toISOString(),
        pid: process.pid,
      });
    } catch (error) {
      this.log(`[scheduler] tick failed: ${error.stack || error.message}`);
      await updateState({ status: 'idle', last_heartbeat_at: new Date().toISOString() }).catch(() => {});
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  /** Sends the daily summary once its hour has passed. */
  async maybeDigest() {
    try {
      if (!(await digestDue())) return;
      const outcome = await sendDigest();
      if (outcome.sent) {
        this.log(`[digest] sent ${outcome.posts} item(s) in ${outcome.sections} section(s)`);
      }
    } catch (error) {
      this.log(`[digest] failed: ${error.message}`);
    }
  }

  /** Housekeeping: drop check logs older than the configured retention. */
  async maybeCleanup() {
    const hour = 60 * 60 * 1000;
    if (Date.now() - this.lastCleanup < hour) return;
    this.lastCleanup = Date.now();
    const days = await getInt('log_retention_days', 30);
    if (days <= 0) return;
    const cutoff = new Date(Date.now() - days * 24 * hour).toISOString();
    const removed = await purgeOlderThan(cutoff);
    if (removed) this.log(`[scheduler] purged ${removed} old check log(s)`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    updateState({ status: 'stopped', next_run_at: null }).catch(() => {});
    this.log('[scheduler] stopped');
  }
}
