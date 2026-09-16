import type { Config } from '@netlify/functions';

process.env.DB_DRIVER ||= 'postgres';

/**
 * Twice a day, hand the work to the background function, which has fifteen
 * minutes instead of thirty seconds. Handing off takes milliseconds, so the
 * schedule never risks a timeout no matter how many websites are watched.
 *
 * If the hand-off fails, the crawl runs here instead, capped to what fits in
 * the budget: fewer websites checked beats none.
 */
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;

  if (base) {
    try {
      const response = await fetch(`${base}/.netlify/functions/crawl-background`, { method: 'POST' });
      console.log(`[crawl] handed off to the background function (${response.status})`);
      return;
    } catch (error) {
      console.error(`[crawl] hand-off failed, running inline: ${(error as Error).message}`);
    }
  }

  const [bootstrap, crawler, settings, digest] = await Promise.all([
    import('../../src/bootstrap.js'),
    import('../../src/crawler/index.js'),
    import('../../src/db/repositories/settings.repo.js'),
    import('../../src/notifications/digest.js'),
  ]);

  await bootstrap.ensureReady({ log: console.log });
  if (!(await settings.getBool('crawler_enabled', true))) return;

  const outcome = await crawler.runDueChecks({
    concurrency: await settings.getInt('crawler_concurrency', 8),
    limitWebsites: 20,
  });
  console.log(`[crawl] inline: ${outcome.checked} website(s), ${outcome.newItems} new item(s)`);

  if (await digest.digestDue()) await digest.sendDigest();
};

export const config: Config = {
  // ~23:00 and ~07:00 in Madrid.
  schedule: '0 5,21 * * *',
};
