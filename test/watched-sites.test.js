import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/** The watched list lives in code and is published on every boot. */
const cleanup = useTempDatabase('watched-sites');
process.env.SEED_WATCHED_SITES = 'true';
process.env.SEED_WORKER_EMAIL = '';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { seedInitialData } = await import('../src/bootstrap.js');
const { listWebsites, createWebsite, setActive } = await import('../src/db/repositories/websites.repo.js');
const { RETIRED_SITES, WATCHED_SITES } = await import('../src/config/sites.js');

await runMigrations({ log: () => {} });

test.after(async () => {
  await closeDb();
  cleanup();
});

const byUrl = (websites) => new Set(websites.map((w) => w.url.replace(/\/+$/, '')));

test('the list in src/config/sites.js is well formed', () => {
  assert.ok(WATCHED_SITES.length > 0, 'there is something to watch');
  const urls = new Set();
  for (const site of WATCHED_SITES) {
    assert.ok(site.name?.trim(), 'every site has a name');
    const url = new URL(site.url);
    assert.equal(url.protocol, 'https:', `${site.name} is read over https`);
    assert.ok(!urls.has(site.url), `${site.url} appears once`);
    urls.add(site.url);
  }
});

test('booting publishes every watched site and retires the old ones', async () => {
  // A retired site that is still in the database, active, from an older deploy.
  await createWebsite({
    name: 'FFSP',
    url: RETIRED_SITES[0],
    active: true,
    check_interval: 600,
    detection_method: 'auto',
    selector_config: {},
  });

  await seedInitialData({ log: () => {} });

  const websites = await listWebsites();
  const urls = byUrl(websites);
  for (const site of WATCHED_SITES) {
    assert.ok(urls.has(site.url.replace(/\/+$/, '')), `${site.name} is published`);
  }

  const retired = websites.find((w) => w.url.replace(/\/+$/, '') === RETIRED_SITES[0].replace(/\/+$/, ''));
  assert.equal(retired.active, false, 'a retired site stops being checked');
  assert.ok(retired, 'but keeps its history instead of being deleted');
});

test('booting again is idempotent and does not resurrect a deactivated site', async () => {
  const before = await listWebsites();
  const target = before.find((w) => w.active);
  await setActive(target.id, false);

  await seedInitialData({ log: () => {} });

  const after = await listWebsites();
  assert.equal(after.length, before.length, 'no duplicates on the second boot');
  assert.equal(
    after.find((w) => w.id === target.id).active,
    false,
    'a site switched off from the dashboard stays off',
  );
});
