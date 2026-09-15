import { config } from './config/index.js';
import { bootstrap } from './bootstrap.js';
import { createApp } from './api/server.js';
import { Scheduler } from './scheduler/index.js';
import { closeDb } from './db/index.js';
import { updateState } from './db/repositories/crawlerState.repo.js';

bootstrap();

const app = createApp();
const server = app.listen(config.server.port, config.server.host, () => {
  console.log(`[web] dashboard on http://localhost:${config.server.port}`);
  console.log(`[web] mail transport: ${config.mail.transport}`);
});

let scheduler = null;
if (config.crawler.runInWeb) {
  scheduler = new Scheduler().start();
} else {
  console.log('[web] scheduler disabled here - run it with `npm run crawler`');
}

const shutdown = (signal) => {
  console.log(`\n[web] ${signal} received, shutting down`);
  scheduler?.stop();
  if (!scheduler) updateState({ status: 'stopped' });
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
