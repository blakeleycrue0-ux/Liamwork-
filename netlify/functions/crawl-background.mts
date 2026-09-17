// Serverless has no writable disk: Postgres, never SQLite.
process.env.DB_DRIVER ||= 'postgres';

/**
 * The full pass: crawl the 27 websites, let Claude judge whatever moved, and
 * send the morning report if its hour has arrived.
 *
 * Background functions get 15 minutes instead of the 30 seconds a scheduled
 * function gets, which is what makes fetching a dozen pages from each of 27
 * sites - some of them slow - finish comfortably in one go.
 *
 * Invoked by crawl-scheduled, which returns immediately.
 */
export default async () => {
  const startedAt = Date.now();

  try {
    const [bootstrap, monitor, settings, state] = await Promise.all([
      import('../../src/bootstrap.js'),
      import('../../src/monitor/index.js'),
      import('../../src/db/repositories/settings.repo.js'),
      import('../../src/db/repositories/crawlerState.repo.js'),
    ]);

    await bootstrap.ensureReady({ log: console.log });

    if (!(await settings.getBool('crawler_enabled', true))) {
      await state.updateState({ status: 'paused', last_heartbeat_at: new Date().toISOString() });
      console.log('[crawl] crawler desactivado en la configuración');
      return;
    }

    const { pipeline, report } = await monitor.runScheduledPass({ now: new Date() });

    console.log(
      `[crawl] ${pipeline.crawl.websites} web(s), ${pipeline.crawl.pagesChanged} página(s) con cambios, ` +
        `${pipeline.analysis.analyzed} analizada(s) en ${pipeline.analysis.batches} llamada(s), ` +
        `${pipeline.analysis.reported} para el informe, ${pipeline.crawl.failed} error(es) ` +
        `en ${Date.now() - startedAt}ms`,
    );
    if (pipeline.analysis.usage.input) {
      console.log(
        `[claude] ${pipeline.analysis.usage.input} tokens de entrada ` +
          `(${pipeline.analysis.usage.cached} desde caché), ${pipeline.analysis.usage.output} de salida`,
      );
    }
    for (const error of pipeline.analysis.errors) console.error(`[claude] ${error}`);

    if (report?.sent) {
      console.log(`[informe] enviado el del ${report.date}: ${report.changes} cambio(s)`);
    } else if (report?.reason && report.reason !== 'not-due') {
      console.log(`[informe] no enviado: ${report.reason}`);
    }
  } catch (error) {
    const details = error instanceof Error ? error : new Error(String(error));
    console.error('[crawl] falló:', details.stack ?? details.message);
  }
};
