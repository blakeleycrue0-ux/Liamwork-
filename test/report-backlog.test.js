import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * The bug this file exists for: a change filed under an older day - because a
 * crawl was missed, or because the gap between two crawls straddled midnight -
 * was invisible to every report that came after it, permanently. The report
 * asked for `change_date = yesterday` and nothing else, so an empty "Sin
 * cambios" email could go out while real changes sat in the database.
 *
 * The rule now: a change stays pending until a report that ACTUALLY WENT OUT
 * claimed it, and every report sweeps up whatever is still pending.
 */
const cleanup = useTempDatabase('report-backlog');
process.env.AUTH_PROVIDER = 'none';
delete process.env.ANTHROPIC_API_KEY; // no model calls in this file

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/index.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { createWorker } = await import('../src/db/repositories/workers.repo.js');
const { recordChange, changesForReport, countPendingForReport } = await import(
  '../src/db/repositories/changes.repo.js'
);
const { getReport } = await import('../src/db/repositories/reports.repo.js');
const { setSettings } = await import('../src/db/repositories/settings.repo.js');
const { buildReport, sendDailyReport } = await import('../src/monitor/report.js');
const { buildReportEmail } = await import('../src/monitor/report.email.js');

await runMigrations({ log: () => {} });

const website = await createWebsite({
  name: 'Club de prueba',
  url: 'https://club.example',
  active: true,
  check_interval: 60,
  detection_method: 'html',
  selector_config: {},
});
await createWorker({ name: 'Destinatario', email: 'destinatario@example.com', active: true });

test.after(async () => {
  await closeDb();
  cleanup();
});

let sequence = 0;
/**
 * A relevant change, dated on purpose. No page or version: this file is about
 * how reports claim changes, not about how changes are produced, and leaving
 * both null keeps UNIQUE(to_version_id, page_id) out of the way.
 */
const addChange = (date, overrides = {}) => {
  sequence += 1;
  return recordChange({
    websiteId: website.id,
    toVersionId: null,
    pageId: null,
    changeDate: date,
    changeType: 'UPDATED',
    priority: 'MEDIUM',
    title: `Cambio del ${date} #${sequence}`,
    url: `https://club.example/n${sequence}`,
    summary: 'Algo cambió',
    whatChanged: 'Un texto',
    analyzer: 'test',
    ...overrides,
  });
};

const reportedIn = async (title) => {
  const row = await (await getDb()).get('SELECT reported_in FROM detected_changes WHERE title = ?', [title]);
  return row?.reported_in ?? null;
};

/* ============================ TEST OBLIGATORIO A-H ======================= */

test('A-H: un cambio cuyo informe no se envió reaparece al día siguiente, y solo una vez', async () => {
  // A) Day 1 detects a change.
  const day1 = await addChange('2026-03-01', { title: 'Cambio del día 1' });
  assert.ok(day1, 'el cambio queda registrado');

  // B) Its report is built but never sent - a preview, or a send that failed.
  const built = await buildReport({ date: '2026-03-01', timeZone: 'Europe/Madrid' });
  assert.equal(built.total_changes, 1);
  assert.equal(
    await reportedIn('Cambio del día 1'),
    null,
    'construir un informe NO marca el cambio como informado',
  );

  // C+D) The next day's report runs.
  const nextDay = await buildReport({ date: '2026-03-02', timeZone: 'Europe/Madrid' });

  // E) The change from the previous day is in it.
  assert.equal(nextDay.total_changes, 1, 'el cambio atrasado aparece');
  assert.equal(nextDay.payload.changes[0].title, 'Cambio del día 1');
  assert.equal(nextDay.payload.pending_from_previous_days, 1, 'y se contabiliza como atrasado');
  assert.equal(nextDay.backlog, 1);

  // F) Now the report is actually sent.
  const sent = await sendDailyReport({ date: '2026-03-02' });
  assert.equal(sent.sent, true);
  assert.equal(sent.changes, 1);
  assert.equal(sent.backlog, 1);

  const report = await getReport('2026-03-02');
  assert.ok(report.sent_at, 'daily_reports.sent_at queda marcado');
  assert.equal(
    await reportedIn('Cambio del día 1'),
    report.id,
    'y ahora sí el cambio queda atado a ESE informe',
  );

  // G+H) A later report must not carry it again.
  const dayAfter = await buildReport({ date: '2026-03-03', timeZone: 'Europe/Madrid' });
  assert.equal(dayAfter.total_changes, 0, 'no se repite en el informe siguiente');
  assert.equal(
    await countPendingForReport({ date: '2026-03-03' }),
    0,
    'y no queda nada pendiente',
  );
});

/* ============================ TEST ADICIONAL ============================= */

test('6 atrasados + 3 de ayer = 9 en el informe, y 0 pendientes después', async () => {
  for (let i = 1; i <= 6; i += 1) {
    await addChange('2026-04-10', { title: `Atrasado ${i}`, priority: i <= 2 ? 'HIGH' : 'LOW' });
  }
  for (let i = 1; i <= 3; i += 1) {
    await addChange('2026-04-14', { title: `De ayer ${i}`, priority: 'MEDIUM' });
  }

  assert.equal(await countPendingForReport({ date: '2026-04-14' }), 9);

  const report = await buildReport({ date: '2026-04-14', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 9, 'los 9 van en el mismo informe');
  assert.equal(report.payload.pending_from_previous_days, 6, '6 de ellos son atrasados');
  assert.equal(report.high_priority, 2);
  assert.equal(report.medium_priority, 3);
  assert.equal(report.low_priority, 4);

  const sent = await sendDailyReport({ date: '2026-04-14' });
  assert.equal(sent.sent, true);
  assert.equal(sent.changes, 9);

  assert.equal(
    await countPendingForReport({ date: '2026-04-15' }),
    0,
    'segundo intento: cero pendientes',
  );
  const after = await buildReport({ date: '2026-04-15', timeZone: 'Europe/Madrid' });
  assert.equal(after.total_changes, 0);
});

test('un cambio solo puede pertenecer a un informe enviado', async () => {
  const rows = await (await getDb()).all(
    `SELECT c.id, c.title, c.reported_in, r.sent_at
     FROM detected_changes c LEFT JOIN daily_reports r ON r.id = c.reported_in
     WHERE c.reported_in IS NOT NULL`,
  );
  assert.ok(rows.length >= 10, 'hay cambios ya informados');
  for (const row of rows) {
    assert.ok(row.sent_at, `"${row.title}" está atado a un informe que SÍ se envió`);
  }
});

/* ======================= REENVIO DEL MISMO INFORME ======================= */

test('reenviar el informe de una fecha reproduce su contenido, no lo vacía', async () => {
  const report = await getReport('2026-04-14');
  const same = await changesForReport({ date: '2026-04-14', reportId: report.id });
  assert.equal(same.length, 9, 'sus propios cambios siguen siendo suyos');

  const forced = await sendDailyReport({ date: '2026-04-14', force: true });
  assert.equal(forced.sent, true);
  assert.equal(forced.changes, 9, 'el reenvío lleva lo mismo, no un informe vacío');
});

test('sin force, un informe ya enviado no se manda otra vez', async () => {
  const again = await sendDailyReport({ date: '2026-04-14' });
  assert.equal(again.sent, false);
  assert.equal(again.reason, 'already-sent');
});

/* ========================== EMAIL VACIO ================================== */

test('report_send_when_empty=true: sin nada pendiente, sale el correo de "sin cambios"', async () => {
  await setSettings({ report_send_when_empty: 'true' });
  assert.equal(await countPendingForReport({ date: '2026-05-20' }), 0);

  const sent = await sendDailyReport({ date: '2026-05-20' });
  assert.equal(sent.sent, true);
  assert.equal(sent.changes, 0);

  const email = buildReportEmail(await buildReport({ date: '2026-05-20' }));
  assert.match(email.text, /Sin cambios relevantes/);
  assert.match(email.subject, /sin cambios/);
});

test('report_send_when_empty=false: sin nada pendiente, no sale nada', async () => {
  await setSettings({ report_send_when_empty: 'false' });
  const sent = await sendDailyReport({ date: '2026-05-21' });
  assert.equal(sent.sent, false);
  assert.equal(sent.reason, 'no-changes');
  await setSettings({ report_send_when_empty: 'true' });
});

test('"Sin cambios" NUNCA se envía existiendo cambios pendientes', async () => {
  // The exact failure seen in the controlled run: an empty email while six
  // real changes sat in the database under an earlier date.
  await addChange('2026-06-01', { title: 'Pendiente que no debe perderse', priority: 'HIGH' });

  for (const date of ['2026-06-02', '2026-06-03', '2026-06-04']) {
    const report = await buildReport({ date, timeZone: 'Europe/Madrid' });
    const email = buildReportEmail(report);
    assert.equal(report.total_changes, 1, `el ${date} sigue arrastrando el pendiente`);
    assert.doesNotMatch(email.text, /Sin cambios relevantes/, `el ${date} no dice "sin cambios"`);
    assert.match(email.text, /atrasado: del 2026-06-01/, 'y avisa de que viene atrasado');
  }

  const sent = await sendDailyReport({ date: '2026-06-04' });
  assert.equal(sent.sent, true);
  assert.equal(sent.changes, 1);

  // Once delivered, it stops following the reports around.
  const clean = await buildReport({ date: '2026-06-05', timeZone: 'Europe/Madrid' });
  assert.equal(clean.total_changes, 0);
});

test('solo NEW y UPDATED son arrastrados; UNCHANGED e IGNORED no', async () => {
  await addChange('2026-07-01', { title: 'Descartado', changeType: 'IGNORED', priority: 'LOW' });
  await addChange('2026-07-01', { title: 'Sin cambios', changeType: 'UNCHANGED', priority: 'LOW' });
  assert.equal(await countPendingForReport({ date: '2026-07-05' }), 0);
});

test('un cambio del futuro no se cuela en el informe de hoy', async () => {
  await addChange('2026-12-31', { title: 'Del futuro' });
  const report = await buildReport({ date: '2026-08-01', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 0, 'change_date <= fecha del informe');
  assert.equal(await countPendingForReport({ date: '2026-12-31' }), 1, 'pero sigue pendiente');
});
