import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * Two protections that only show up under pressure:
 *
 *   - two senders at the same instant must produce ONE email, not two
 *   - max_items_per_email must cap the email without losing what it cut
 *
 * Both were found by auditing the running system, not by reading the code:
 * the race really did send two emails, and the setting really was ignored.
 */
const cleanup = useTempDatabase('report-limits');
process.env.AUTH_PROVIDER = 'none';
delete process.env.ANTHROPIC_API_KEY; // no model calls here

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/index.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { createWorker } = await import('../src/db/repositories/workers.repo.js');
const { recordChange, countPendingForReport } = await import('../src/db/repositories/changes.repo.js');
const { getReport } = await import('../src/db/repositories/reports.repo.js');
const { setSettings } = await import('../src/db/repositories/settings.repo.js');
const { buildReport, sendDailyReport } = await import('../src/monitor/report.js');
const { buildReportEmail } = await import('../src/monitor/report.email.js');
const { claimForSending, releaseClaim } = await import('../src/db/repositories/reports.repo.js');

await runMigrations({ log: () => {} });

const website = await createWebsite({
  name: 'Club', url: 'https://club.example', active: true,
  check_interval: 60, detection_method: 'html', selector_config: {},
});
await createWorker({ name: 'Destinatario', email: 'destinatario@example.com', active: true });

test.after(async () => {
  await closeDb();
  cleanup();
});

let sequence = 0;
const addChange = (date, overrides = {}) => {
  sequence += 1;
  return recordChange({
    websiteId: website.id,
    toVersionId: null,
    pageId: null,
    changeDate: date,
    changeType: 'UPDATED',
    priority: 'MEDIUM',
    title: `Cambio ${sequence}`,
    url: `https://club.example/n${sequence}`,
    summary: 'Algo cambió',
    whatChanged: 'Un texto',
    analyzer: 'test',
    ...overrides,
  });
};

/* ==================== 1) DOS ENVIOS SIMULTANEOS ========================= */

test('dos sendDailyReport a la vez para la misma fecha envían exactamente 1 email', async () => {
  for (let i = 0; i < 3; i += 1) await addChange('2026-03-10', { priority: 'HIGH' });

  const db = await getDb();

  const before = Number((await db.get('SELECT COUNT(*) AS n FROM daily_reports')).n);

  const results = await Promise.all([
    sendDailyReport({ date: '2026-03-10' }),
    sendDailyReport({ date: '2026-03-10' }),
  ]);

  const winners = results.filter((result) => result.sent);
  const losers = results.filter((result) => !result.sent);

  assert.equal(winners.length, 1, 'exactamente un envío gana');
  assert.equal(losers.length, 1, 'y el otro se retira');
  assert.equal(losers[0].reason, 'already-sent');
  assert.equal(winners[0].changes, 3);

  const rows = await db.all('SELECT sent_at FROM daily_reports WHERE report_date = ?', ['2026-03-10']);
  assert.equal(rows.length, 1, 'una sola fila para esa fecha');
  assert.ok(rows[0].sent_at, 'marcada como enviada');
  assert.equal(
    Number((await db.get('SELECT COUNT(*) AS n FROM daily_reports')).n),
    before + 1,
    'no se duplica el informe',
  );
});

test('tres envíos simultáneos siguen siendo un solo email', async () => {
  for (let i = 0; i < 2; i += 1) await addChange('2026-03-11');

  const results = await Promise.all([
    sendDailyReport({ date: '2026-03-11' }),
    sendDailyReport({ date: '2026-03-11' }),
    sendDailyReport({ date: '2026-03-11' }),
  ]);

  assert.equal(results.filter((result) => result.sent).length, 1);
  assert.equal(results.filter((result) => result.reason === 'already-sent').length, 2);
});

test('el perdedor de la carrera no reclama ningún cambio', async () => {
  const db = await getDb();
  const report = await getReport('2026-03-10');
  const claimed = await db.all('SELECT id FROM detected_changes WHERE reported_in = ?', [report.id]);
  assert.equal(claimed.length, 3, 'los 3 cambios cuelgan del único informe enviado');

  const orphans = await db.all(
    `SELECT c.id FROM detected_changes c
     LEFT JOIN daily_reports r ON r.id = c.reported_in
     WHERE c.reported_in IS NOT NULL AND r.sent_at IS NULL`,
  );
  assert.equal(orphans.length, 0, 'ningún cambio atado a un informe sin enviar');
});

/* ==================== 2) max_items_per_email =========================== */

test('25 cambios con límite 20: se envían 20 y quedan 5 pendientes', async () => {
  await setSettings({ max_items_per_email: 20 });
  for (let i = 1; i <= 25; i += 1) {
    await addChange('2026-04-01', { title: `Lote A ${i}`, priority: 'MEDIUM' });
  }
  assert.equal(await countPendingForReport({ date: '2026-04-01' }), 25);

  const report = await buildReport({ date: '2026-04-01', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 20, 'el informe lleva 20');
  assert.equal(report.payload.changes.length, 20);
  assert.equal(report.heldBack, 5, 'y deja 5 fuera');
  assert.equal(report.payload.held_back_for_next_report, 5);

  const email = buildReportEmail(report);
  assert.match(email.text, /5 further changes are held for the next report/);

  const sent = await sendDailyReport({ date: '2026-04-01' });
  assert.equal(sent.sent, true);
  assert.equal(sent.changes, 20);
  assert.equal(sent.heldBack, 5);
});

test('el siguiente informe saca los 5 que quedaron', async () => {
  assert.equal(await countPendingForReport({ date: '2026-04-02' }), 5, 'quedan exactamente 5');

  const report = await buildReport({ date: '2026-04-02', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 5);
  assert.equal(report.heldBack, 0, 'ya caben todos');
  assert.equal(report.backlog, 5, 'y se marcan como atrasados');

  const sent = await sendDailyReport({ date: '2026-04-02' });
  assert.equal(sent.sent, true);
  assert.equal(sent.changes, 5);

  assert.equal(await countPendingForReport({ date: '2026-04-03' }), 0);
});

test('no se pierde ni un cambio: los 25 acaban en un informe enviado, sin repetirse', async () => {
  const db = await getDb();
  const rows = await db.all(
    `SELECT c.id, c.reported_in, r.sent_at
     FROM detected_changes c
     LEFT JOIN daily_reports r ON r.id = c.reported_in
     WHERE c.title LIKE 'Lote A %'`,
  );
  assert.equal(rows.length, 25, 'los 25 siguen existiendo');
  for (const row of rows) {
    assert.ok(row.reported_in, `el cambio ${row.id} fue informado`);
    assert.ok(row.sent_at, `y su informe se envió de verdad`);
  }
  // Two reports between them, each change in exactly one.
  const perReport = new Map();
  for (const row of rows) perReport.set(row.reported_in, (perReport.get(row.reported_in) ?? 0) + 1);
  assert.deepEqual([...perReport.values()].sort((a, b) => a - b), [5, 20]);
});

test('el límite corta por el extremo menos importante', async () => {
  await setSettings({ max_items_per_email: 3 });
  await addChange('2026-05-01', { title: 'Baja 1', priority: 'LOW' });
  await addChange('2026-05-01', { title: 'Alta 1', priority: 'HIGH' });
  await addChange('2026-05-01', { title: 'Media 1', priority: 'MEDIUM' });
  await addChange('2026-05-01', { title: 'Alta 2', priority: 'HIGH' });
  await addChange('2026-05-01', { title: 'Baja 2', priority: 'LOW' });

  const report = await buildReport({ date: '2026-05-01', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 3);
  assert.equal(report.heldBack, 2);
  assert.deepEqual(
    report.payload.changes.map((change) => change.priority),
    ['HIGH', 'HIGH', 'MEDIUM'],
    'las dos altas y la media entran; las bajas esperan',
  );
  assert.equal(report.high_priority, 2, 'los recuentos son de lo que va dentro');
  assert.equal(report.low_priority, 0);

  await sendDailyReport({ date: '2026-05-01' });
  const next = await buildReport({ date: '2026-05-02', timeZone: 'Europe/Madrid' });
  assert.deepEqual(next.payload.changes.map((change) => change.title).sort(), ['Baja 1', 'Baja 2']);
  await setSettings({ max_items_per_email: 20 });
});

/* ==================== 3) LA PREVIEW NUNCA MARCA ======================== */

test('una preview nunca marca cambios como enviados, por muchas veces que se pida', async () => {
  await addChange('2026-06-01', { title: 'Solo previsualizado', priority: 'HIGH' });
  const db = await getDb();

  // Three builds in a row. The report also sweeps the two LOW changes the
  // limit held back earlier - that is the backlog working, and it must still
  // not claim anything.
  for (let i = 0; i < 3; i += 1) {
    const preview = await buildReport({ date: '2026-06-01', timeZone: 'Europe/Madrid' });
    assert.equal(preview.total_changes, 3, 'el pendiente nuevo más los dos que quedaron');
    assert.ok(
      preview.payload.changes.some((change) => change.title === 'Solo previsualizado'),
      'incluye el cambio previsualizado',
    );
  }

  const row = await db.get('SELECT reported_in FROM detected_changes WHERE title = ?', [
    'Solo previsualizado',
  ]);
  assert.equal(row.reported_in, null, 'sigue sin reclamar');

  const report = await getReport('2026-06-01');
  assert.equal(report.sent_at, null, 'y el informe sigue sin enviarse');
  assert.equal(await countPendingForReport({ date: '2026-06-01' }), 3, 'siguen pendientes');
});

test('tras un envío fallido la reserva se devuelve y el informe se reintenta', async () => {
  // The claim is taken BEFORE the mail leaves, so a failed send must hand it
  // back - otherwise one SMTP outage would mark the day delivered for ever.
  // This drives the same two calls sendDailyReport makes on that path.
  const db = await getDb();
  await buildReport({ date: '2026-06-01', timeZone: 'Europe/Madrid' });

  assert.equal(await claimForSending('2026-06-01', ['a@example.com']), true, 'la reserva se toma');
  assert.equal(
    await claimForSending('2026-06-01', ['b@example.com']),
    false,
    'y nadie más puede tomarla',
  );

  await releaseClaim('2026-06-01', 'SMTP caído durante la prueba');
  const released = await getReport('2026-06-01');
  assert.equal(released.sent_at, null, 'la reserva vuelve a estar libre');
  assert.match(released.error, /SMTP caído/);
  assert.equal(
    await countPendingForReport({ date: '2026-06-01' }),
    3,
    'y los cambios siguen pendientes, sin perderse',
  );

  const retry = await sendDailyReport({ date: '2026-06-01' });
  assert.equal(retry.sent, true, 'el reintento funciona');
  assert.equal(retry.changes, 3);
  assert.equal(await countPendingForReport({ date: '2026-06-02' }), 0, 'y ya no queda nada');
});
