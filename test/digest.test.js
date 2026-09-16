import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('digest');
delete process.env.ANTHROPIC_API_KEY;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const websites = await import('../src/db/repositories/websites.repo.js');
const workers = await import('../src/db/repositories/workers.repo.js');
const posts = await import('../src/db/repositories/posts.repo.js');
const settings = await import('../src/db/repositories/settings.repo.js');
const { digestDue, digestStatus, localParts, sendDigest } = await import('../src/notifications/digest.js');

await runMigrations({ log: () => {} });
await workers.createWorker({ name: 'Jefe', email: 'jefe@example.com', active: true });

const website = await websites.createWebsite({
  name: 'FFSP',
  url: 'https://ffsp.info/calendario',
  active: true,
  check_interval: 60,
  detection_method: 'auto',
  selector_config: {},
});

test.after(async () => {
  await closeDb();
  cleanup();
});

const addFindings = (titles) =>
  posts.insertNewItems(
    website.id,
    titles.map((title, index) => ({ title, url: `https://ffsp.info/p${index}`, contentHash: `${title}-${index}` })),
  );

test('the local date and hour follow the configured timezone, not the server', () => {
  // 22:30 UTC is already the next day in Madrid (UTC+2 in September).
  const parts = localParts('Europe/Madrid', new Date('2026-09-16T22:30:00Z'));
  assert.equal(parts.date, '2026-09-17');
  assert.equal(parts.hour, 0);
});

test('the summary waits for its hour, then goes out once a day', async () => {
  await settings.setSettings({ notification_mode: 'digest', digest_hour: 20, digest_timezone: 'Europe/Madrid' });
  await addFindings(['FFSP - Son Sardina, 04/10/2026', 'Cambio de horario jornada 3']);

  // 10:00 in Madrid: too early.
  assert.equal(await digestDue(new Date('2026-09-16T08:00:00Z')), false);

  // 21:00 in Madrid: due.
  const evening = new Date('2026-09-16T19:00:00Z');
  assert.equal(await digestDue(evening), true);

  const outcome = await sendDigest({ now: evening });
  assert.equal(outcome.sent, true);
  assert.equal(outcome.posts, 2);
  assert.deepEqual(outcome.recipients, ['jefe@example.com']);

  // Already sent today: not due again, and nothing is left pending.
  assert.equal(await digestDue(evening), false);
  assert.equal((await posts.pendingForDigest()).length, 0);
});

test('a finding detected after the summary goes into the next one', async () => {
  await addFindings(['Nuevo torneo de primavera']);
  const status = await digestStatus(new Date('2026-09-16T19:30:00Z'));
  assert.equal(status.pending_items, 1);
  assert.equal(status.sent_today, true);

  // Next day, same hour: due again with just that finding.
  const tomorrow = new Date('2026-09-17T19:00:00Z');
  assert.equal(await digestDue(tomorrow), true);
  const outcome = await sendDigest({ now: tomorrow });
  assert.equal(outcome.posts, 1);
});

test('forcing it with nothing pending still sends, so "enviar ahora" always works', async () => {
  const outcome = await sendDigest({ force: true, now: new Date('2026-09-17T19:10:00Z') });
  assert.equal(outcome.sent, true);
  assert.equal(outcome.posts, 0);
});

test('without the AI key the summary still groups the findings by website', async () => {
  const { summariseDigest } = await import('../src/notifications/digest.ai.js');
  const summary = await summariseDigest([
    { website_name: 'FFSP', title: 'Partido aplazado', url: 'https://ffsp.info/x' },
    { website_name: 'FFSP', title: 'Nueva jornada', url: '' },
  ]);
  assert.equal(summary.generatedByAi, false);
  assert.equal(summary.sections.length, 1);
  assert.equal(summary.sections[0].items.length, 2);
});

test('in digest mode a check does not email on the spot', async () => {
  const { checkWebsite } = await import('../src/crawler/index.js');
  const { startFixtureSite } = await import('./helpers.js');
  const site = await startFixtureSite({ posts: [{ title: 'Jornada 5 publicada', url: '/j5' }] });

  const watched = await websites.createWebsite({
    name: 'Fixture',
    url: site.url,
    active: true,
    check_interval: 60,
    detection_method: 'auto',
    selector_config: {},
  });
  await checkWebsite(watched); // baseline
  site.addPost({ title: 'Jornada 6 publicada', url: '/j6' });
  const result = await checkWebsite(await websites.getWebsite(watched.id));
  await site.close();

  assert.equal(result.newItems, 1);
  assert.equal(result.notified, false, 'it waits for the daily summary');
  assert.equal(result.notification.reason, 'waiting-for-digest');
  assert.ok((await posts.pendingForDigest()).some((post) => post.title.includes('Jornada 6')));
});
