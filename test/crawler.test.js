import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixtureSite, useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('crawler');
const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const websites = await import('../src/db/repositories/websites.repo.js');
const workers = await import('../src/db/repositories/workers.repo.js');
const posts = await import('../src/db/repositories/posts.repo.js');
const logs = await import('../src/db/repositories/checkLogs.repo.js');
const settings = await import('../src/db/repositories/settings.repo.js');
const { checkWebsite, runDueChecks, isDue } = await import('../src/crawler/index.js');

await runMigrations({ log: () => {} });
// These tests cover the instant-alert path; the daily digest has its own file.
await settings.setSettings({ notification_mode: 'instant' });
await workers.createWorker({ name: 'Test Worker', email: 'test-worker@example.com', active: true });
await workers.createWorker({ name: 'Inactive', email: 'inactive@example.com', active: false });

test.after(async () => {
  await closeDb();
  cleanup();
});

test('full lifecycle: baseline, new post, no duplicate alert', async (t) => {
  const site = await startFixtureSite({
    posts: [{ title: 'New tournament announced', url: '/example' }],
  });
  t.after(() => site.close());

  const website = await websites.createWebsite({
    name: 'Fixture',
    url: site.url,
    active: true,
    check_interval: 60,
    detection_method: 'auto',
    selector_config: {},
  });

  // 1. First check = baseline: items stored, no email.
  const first = await checkWebsite(website);
  assert.equal(first.ok, true);
  assert.equal(first.method, 'rss', 'RSS must be preferred over HTML scraping');
  assert.equal(first.baseline, true);
  assert.equal(first.newItems, 1);
  assert.equal(first.notified, false);

  const afterFirst = await websites.getWebsite(website.id);
  assert.ok(afterFirst.last_checked_at, 'last check must be persisted');
  assert.ok(afterFirst.last_success_at);

  // 2. Same content again -> nothing new, no email.
  const second = await checkWebsite(await websites.getWebsite(website.id));
  assert.equal(second.newItems, 0);
  assert.equal(second.notified, false);

  // 3. A genuinely new publication -> detected and notified once.
  site.addPost({ title: 'New tournament announced for 2027', url: '/example-2' });
  const third = await checkWebsite(await websites.getWebsite(website.id));
  assert.equal(third.newItems, 1);
  assert.equal(third.notified, true);
  assert.deepEqual(third.notification.recipients, ['test-worker@example.com'], 'only active workers');

  // 4. Re-check: the known post must not be alerted twice.
  const fourth = await checkWebsite(await websites.getWebsite(website.id));
  assert.equal(fourth.newItems, 0);
  assert.equal(fourth.notified, false);

  const stored = await posts.listPosts({ websiteId: website.id });
  assert.equal(stored.length, 2);
  assert.ok(stored.every((post) => post.notified_at), 'every post is closed exactly once');

  const websiteLogs = await logs.listLogs({ websiteId: website.id });
  assert.equal(websiteLogs.length, 4);
  assert.ok(websiteLogs.every((log) => log.success));
});

test('HTML scraping is used when the site has no feed', async (t) => {
  const site = await startFixtureSite({
    posts: [{ title: 'Noticia solo en HTML del club', url: '/html-1' }],
    withFeed: false,
  });
  t.after(() => site.close());

  const website = await websites.createWebsite({
    name: 'HTML only',
    url: site.url,
    active: true,
    check_interval: 60,
    detection_method: 'html',
    selector_config: { list: 'article.post', title: 'h2 a', link: 'a', date: 'time' },
  });

  const result = await checkWebsite(website);
  assert.equal(result.ok, true);
  assert.equal(result.method, 'html');
  assert.equal(result.itemsFound, 1);
});

test('a failing website does not stop the others', async (t) => {
  const broken = await startFixtureSite({ failing: true });
  const healthy = await startFixtureSite({ posts: [{ title: 'Sigue funcionando', url: '/ok' }] });
  t.after(async () => {
    await broken.close();
    await healthy.close();
  });

  const brokenSite = await websites.createWebsite({
    name: 'Broken', url: broken.url, active: true, check_interval: 1,
    detection_method: 'auto', selector_config: {},
  });
  const healthySite = await websites.createWebsite({
    name: 'Healthy', url: healthy.url, active: true, check_interval: 1,
    detection_method: 'auto', selector_config: {},
  });

  const outcome = await runDueChecks();
  const brokenResult = outcome.results.find((r) => r.websiteId === brokenSite.id);
  const healthyResult = outcome.results.find((r) => r.websiteId === healthySite.id);

  assert.equal(brokenResult.ok, false);
  assert.match(brokenResult.error, /500/);
  assert.equal(healthyResult.ok, true, 'the healthy website is still checked');
  assert.ok(outcome.checked >= 2);

  const refreshed = await websites.getWebsite(brokenSite.id);
  assert.equal(refreshed.consecutive_errors, 1);
  assert.ok(refreshed.last_error);
  assert.equal((await logs.listLogs({ websiteId: brokenSite.id, onlyErrors: true })).length, 1);
});

test('inactive websites and workers are skipped', async (t) => {
  const site = await startFixtureSite({ posts: [{ title: 'Nada que notificar aqui', url: '/x' }] });
  t.after(() => site.close());

  const website = await websites.createWebsite({
    name: 'Paused', url: site.url, active: false, check_interval: 60,
    detection_method: 'auto', selector_config: {},
  });

  assert.equal(isDue(website), false);
  const skipped = await checkWebsite(website);
  assert.equal(skipped.skipped, 'inactive');
});

test('interval controls when a website is due', () => {
  const now = Date.now();
  const base = { active: true, check_interval: 60 };
  assert.equal(isDue({ ...base, last_checked_at: null }, now), true);
  assert.equal(isDue({ ...base, last_checked_at: new Date(now - 30_000).toISOString() }, now), false);
  assert.equal(isDue({ ...base, last_checked_at: new Date(now - 61_000).toISOString() }, now), true);
});

test('notify_on_first_check sends an email on the baseline run', async (t) => {
  const site = await startFixtureSite({ posts: [{ title: 'Primera publicacion notificada', url: '/first' }] });
  t.after(async () => {
    await settings.setSettings({ notify_on_first_check: false });
    return site.close();
  });

  await settings.setSettings({ notify_on_first_check: true });
  const website = await websites.createWebsite({
    name: 'Notify first', url: site.url, active: true, check_interval: 60,
    detection_method: 'auto', selector_config: {},
  });

  const result = await checkWebsite(website);
  assert.equal(result.baseline, true);
  assert.equal(result.notified, true);
});
