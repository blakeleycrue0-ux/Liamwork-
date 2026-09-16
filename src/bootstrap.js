import { config, validateConfig } from './config/index.js';
import { getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { createWebsite, listWebsites, setActive } from './db/repositories/websites.repo.js';
import { RETIRED_SITES, WATCHED_SITES } from './config/sites.js';
import { createWorker, listWorkers } from './db/repositories/workers.repo.js';
import { setSettings } from './db/repositories/settings.repo.js';

/**
 * Inserts the initial website/worker ONLY when the tables are still empty.
 * Values come from the environment, so nothing is hardcoded in the crawler and
 * everything stays editable from the dashboard afterwards.
 */
const sameUrl = (a, b) => String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');

export async function seedInitialData({ log = console.log } = {}) {
  const created = { websites: [], worker: null };

  // The watched list lives in code: publish anything missing, on every boot.
  const existing = await listWebsites();
  for (const site of config.seed.watched ? WATCHED_SITES : []) {
    if (existing.some((website) => sameUrl(website.url, site.url))) continue;
    const website = await createWebsite({
      name: site.name,
      url: site.url,
      active: true,
      check_interval: config.seed.websiteInterval,
      detection_method: 'auto',
      selector_config: {},
      notes: null,
    });
    created.websites.push(website.name);
  }
  if (created.websites.length) log(`[seed] ${created.websites.length} website(s) added`);

  // Test sites stay in the history but stop being checked.
  for (const retired of config.seed.watched ? RETIRED_SITES : []) {
    const match = existing.find((website) => sameUrl(website.url, retired));
    if (match?.active) {
      await setActive(match.id, false);
      log(`[seed] retired "${match.name}"`);
    }
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
