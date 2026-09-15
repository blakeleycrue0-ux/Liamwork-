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
export async function seedInitialData({ log = console.log } = {}) {
  const created = { website: null, worker: null };

  if (config.seed.websiteUrl && !(await listWebsites()).length) {
    created.website = await createWebsite({
      name: config.seed.websiteName,
      url: config.seed.websiteUrl,
      active: true,
      check_interval: config.seed.websiteInterval,
      detection_method: 'auto',
      selector_config: {},
      notes: 'Seed inicial - editable desde el dashboard',
    });
    await setSettings({ default_check_interval: config.seed.websiteInterval });
    log(`[seed] website "${created.website.name}" (${created.website.url})`);
  }

  if (config.seed.workerEmail && !(await listWorkers()).length) {
    created.worker = await createWorker({
      name: config.seed.workerName,
      email: config.seed.workerEmail,
      active: true,
    });
    log(`[seed] worker "${created.worker.name}" <${created.worker.email}>`);
  }

  return created;
}

/** Shared start-up sequence for the web server, the crawler and the functions. */
export async function bootstrap({ log = console.log, seed = true } = {}) {
  const warnings = validateConfig();
  for (const warning of warnings) log(`[config] warning: ${warning}`);
  await getDb();
  await runMigrations({ log });
  if (seed) await seedInitialData({ log });
  return { warnings };
}

/** Serverless entry points call this once per cold start. */
let readyPromise = null;
let lastError = null;

export function ensureReady(options) {
  if (!readyPromise) {
    readyPromise = bootstrap(options)
      .then((result) => {
        lastError = null;
        return result;
      })
      .catch((error) => {
        readyPromise = null;
        lastError = error;
        throw error;
      });
  }
  return readyPromise;
}

/** The last start-up failure, so the API can explain itself. */
export const readyError = () => lastError;

/**
 * Waits for the start-up sequence, but never longer than `timeoutMs`.
 * Routes that need the database use this so a slow or unreachable database
 * turns into a clear 503 instead of a platform timeout.
 */
export async function waitForReady({ timeoutMs = 6000, log = () => {} } = {}) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([ensureReady({ log }).then(() => 'ready'), deadline]);
    if (outcome === 'timeout') throw new Error('La base de datos no respondió a tiempo');
    return true;
  } finally {
    clearTimeout(timer);
  }
}
