/**
 * Standalone crawler process. Runs the scheduler without the web server, so
 * the crawler can live on its own machine/container. Set RUN_SCHEDULER_IN_WEB=false
 * in the web process to avoid running two schedulers against the same database.
 */
import { bootstrap } from './bootstrap.js';
import { Scheduler } from './scheduler/index.js';
import { closeDb } from './db/index.js';
import { startOrExit } from './cli/startup.js';

startOrExit(bootstrap);

const scheduler = new Scheduler().start();

const shutdown = (signal) => {
  console.log(`\n[crawler] ${signal} received, shutting down`);
  scheduler.stop();
  closeDb();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the process alive even though every timer is unref'd.
setInterval(() => {}, 1 << 30);
