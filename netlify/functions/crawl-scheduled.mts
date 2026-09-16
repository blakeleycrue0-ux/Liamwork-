import type { Config } from '@netlify/functions';

process.env.DB_DRIVER ||= 'postgres';

/**
 * Twice a day, hand the work to the background function, which has fifteen
 * minutes instead of thirty seconds. Handing off takes milliseconds, so the
 * schedule never risks a timeout no matter how many websites are watched.
 *
 * If the hand-off fails, a reduced pass runs here instead: a few websites
 * checked beats none, and the report still goes out if its hour has passed.
 */
export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL;

  if (base) {
    try {
      const response = await fetch(`${base}/.netlify/functions/crawl-background`, { method: 'POST' });
      console.log(`[crawl] entregado a la función de fondo (${response.status})`);
      return;
    } catch (error) {
      console.error(`[crawl] la entrega falló, se ejecuta aquí: ${(error as Error).message}`);
    }
  }

  const [bootstrap, monitor, settings] = await Promise.all([
    import('../../src/bootstrap.js'),
    import('../../src/monitor/index.js'),
    import('../../src/db/repositories/settings.repo.js'),
  ]);

  await bootstrap.ensureReady({ log: console.log });
  if (!(await settings.getBool('crawler_enabled', true))) return;

  // Capped hard: this path has a 30-second budget, so it does what it can.
  const pipeline = await monitor.runPipeline({ limitWebsites: 6, maxPages: 4 });
  console.log(
    `[crawl] en línea: ${pipeline.crawl.websites} web(s), ${pipeline.crawl.pagesChanged} con cambios`,
  );

  const status = await monitor.reportStatus();
  if (status.due) await monitor.sendDailyReport();
};

export const config: Config = {
  // 05:00 and 21:00 UTC: about 07:00 and 23:00 in Madrid. The morning pass
  // is the one that compares against last night and sends the report.
  schedule: '0 5,21 * * *',
};
