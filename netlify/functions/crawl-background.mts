// Serverless has no writable disk: Postgres, never SQLite.
process.env.DB_DRIVER ||= 'postgres';

/**
 * The actual crawl. Background functions get 15 minutes instead of the 30
 * seconds a scheduled function gets, which is what makes 27 websites -some of
 * them slow- finish comfortably in one pass.
 *
 * Invoked by crawl-scheduled; it returns 202 immediately and keeps working.
 */
export default async (req: Request) => {
  const startedAt = Date.now();

  try {
    const [bootstrap, crawler, settings, state, digest] = await Promise.all([
      import('../../src/bootstrap.js'),
      import('../../src/crawler/index.js'),
      import('../../src/db/repositories/settings.repo.js'),
      import('../../src/db/repositories/crawlerState.repo.js'),
      import('../../src/notifications/digest.js'),
    ]);

    await bootstrap.ensureReady({ log: console.log });

    if (!(await settings.getBool('crawler_enabled', true))) {
      await state.updateState({ status: 'paused', last_heartbeat_at: new Date().toISOString() });
      return;
    }

    await state.updateState({ status: 'running', last_heartbeat_at: new Date().toISOString() });

    const outcome = await crawler.runDueChecks({
      concurrency: await settings.getInt('crawler_concurrency', 8),
    });

    await state.updateState({
      status: 'idle',
      last_run_at: new Date().toISOString(),
      last_run_duration_ms: Date.now() - startedAt,
      last_heartbeat_at: new Date().toISOString(),
      next_run_at: null,
    });

    console.log(
      `[crawl] ${outcome.checked} website(s), ${outcome.newItems} new item(s), ${outcome.failed} error(s) in ${
        Date.now() - startedAt
      }ms`,
    );

    // The report goes out on the pass that runs after its hour.
    if (await digest.digestDue()) {
      const sent = await digest.sendDigest();
      if (sent.sent) console.log(`[digest] sent ${sent.posts} item(s) in ${sent.sections} section(s)`);
    }
  } catch (error) {
    const details = error instanceof Error ? error : new Error(String(error));
    console.error('[crawl] failed:', details.stack ?? details.message);
  }
};
