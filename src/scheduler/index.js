import { purgeOlderThan } from '../db/repositories/checkLogs.repo.js';
import { getBool, getInt } from '../db/repositories/settings.repo.js';
import { updateState } from '../db/repositories/crawlerState.repo.js';
import { runDueChecks } from '../crawler/index.js';

/**
 * Periodic driver for the crawler. It wakes up every `scheduler_tick` seconds,
 * asks the crawler which websites are due and runs them. It can live inside the
 * web server process or in a dedicated process (`npm run crawler`).
 */
export class Scheduler {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this.timer = null;
    this.running = false;
    this.stopped = true;
    this.lastCleanup = 0;
  }

  get tickSeconds() {
    return Math.max(5, getInt('scheduler_tick', 15));
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    updateState({
      status: 'idle',
      pid: process.pid,
      last_heartbeat_at: new Date().toISOString(),
      next_run_at: new Date(Date.now() + this.tickSeconds * 1000).toISOString(),
    });
    this.log(`[scheduler] started (pid ${process.pid}, tick ${this.tickSeconds}s)`);
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
      if (!getBool('crawler_enabled', true)) {
        updateState({ status: 'paused', last_heartbeat_at: new Date().toISOString() });
        return;
      }
      updateState({ status: 'running', last_heartbeat_at: new Date().toISOString(), pid: process.pid });
      const outcome = await runDueChecks();
      if (outcome.checked) {
        this.log(
          `[scheduler] checked ${outcome.checked} website(s), ${outcome.newItems} new item(s), ${outcome.failed} error(s)`,
        );
      }
      this.maybeCleanup();
      updateState({
        status: 'idle',
        last_run_at: new Date().toISOString(),
        last_run_duration_ms: Date.now() - startedAt,
        last_heartbeat_at: new Date().toISOString(),
        next_run_at: new Date(Date.now() + this.tickSeconds * 1000).toISOString(),
        pid: process.pid,
      });
    } catch (error) {
      this.log(`[scheduler] tick failed: ${error.stack || error.message}`);
      updateState({ status: 'idle', last_heartbeat_at: new Date().toISOString() });
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  /** Housekeeping: drop check logs older than the configured retention. */
  maybeCleanup() {
    const hour = 60 * 60 * 1000;
    if (Date.now() - this.lastCleanup < hour) return;
    this.lastCleanup = Date.now();
    const days = getInt('log_retention_days', 30);
    if (days <= 0) return;
    const cutoff = new Date(Date.now() - days * 24 * hour).toISOString();
    const removed = purgeOlderThan(cutoff);
    if (removed) this.log(`[scheduler] purged ${removed} old check log(s)`);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    updateState({ status: 'stopped', next_run_at: null });
    this.log('[scheduler] stopped');
  }
}
