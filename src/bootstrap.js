import { config, validateConfig } from './config/index.js';
import { getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createWebsite, listWebsites } from './db/repositories/websites.repo.js';
import { createWorker, listWorkers } from './db/repositories/workers.repo.js';
import { setSettings } from './db/repositories/settings.repo.js';

/**
 * Inserts the initial website/worker ONLY when the tables are still empty.
 * Values come from the environment, so nothing is hardcoded in the crawler and
 * everything stays editable from the dashboard afterwards.
 */
export function seedInitialData({ log = console.log } = {}) {
  const created = { website: null, worker: null };

  if (!listWebsites().length && config.seed.websiteUrl) {
    created.website = createWebsite({
      name: config.seed.websiteName,
      url: config.seed.websiteUrl,
      active: true,
      check_interval: config.seed.websiteInterval,
      detection_method: 'auto',
      selector_config: {},
      notes: 'Seed inicial - editable desde el dashboard',
    });
    setSettings({ default_check_interval: config.seed.websiteInterval });
    log(`[seed] website "${created.website.name}" (${created.website.url})`);
  }

  if (!listWorkers().length && config.seed.workerEmail) {
    created.worker = createWorker({
      name: config.seed.workerName,
      email: config.seed.workerEmail,
      active: true,
    });
    log(`[seed] worker "${created.worker.name}" <${created.worker.email}>`);
  }

  return created;
}

/** Shared start-up sequence for the web server and the crawler process. */
export function bootstrap({ log = console.log, seed = true } = {}) {
  const warnings = validateConfig();
  for (const warning of warnings) log(`[config] warning: ${warning}`);
  getDb();
  runMigrations({ log });
  if (seed) seedInitialData({ log });
  return { warnings };
}
