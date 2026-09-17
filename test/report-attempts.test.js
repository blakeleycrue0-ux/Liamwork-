import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * Why this file exists.
 *
 * On 2026-09-17 the 07:00 report did not arrive. Every check afterwards said
 * the system was fine: the cron had fired, the 27 websites had been crawled,
 * the report for the previous day existed with its two changes, and
 * `daily_reports.error` was NULL. It was NULL because pressing "Enviar ahora"
 * at 09:08 had cleared it - the forced send overwrites exactly the column that
 * held the explanation.
 *
 * So the failure is not "the email did not go out". The failure is that the
 * system could not say why afterwards. These tests pin down the record that
 * makes it answerable, and the empty-day setting that was wrongly suspected.
 */
const cleanup = useTempDatabase('report-attempts');
process.env.AUTH_PROVIDER = 'none';
delete process.env.ANTHROPIC_API_KEY;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { createWorker, updateWorker, listWorkers } = await import(
  '../src/db/repositories/workers.repo.js'
);
const { recordChange } = await import('../src/db/repositories/changes.repo.js');
const { listAttempts, lastAttempt } = await import('../src/db/repositories/reports.repo.js');
const { setSettings } = await import('../src/db/repositories/settings.repo.js');
const { reportStatus, sendDailyReport } = await import('../src/monitor/report.js');

await runMigrations({ log: () => {} });

const website = await createWebsite({
  name: 'Club', url: 'https://club.example', active: true,
  check_interval: 60, detection_method: 'html', selector_config: {},
});
const worker = await createWorker({ name: 'Destinatario', email: 'destino@example.com', active: true });

test.after(async () => {
  await closeDb();
  cleanup();
});

let sequence = 0;
const addChange = (date) => {
  sequence += 1;
  return recordChange({
    websiteId: website.id, toVersionId: null, pageId: null,
    changeDate: date, changeType: 'UPDATED', priority: 'MEDIUM',
    title: `Cambio ${sequence}`, url: `https://club.example/n${sequence}`,
    summary: 'Algo cambió', whatChanged: 'Un texto', analyzer: 'test',
  });
};

/* ============ 1) TODO ENVÍO DEJA CONSTANCIA ============================= */

test('un envío correcto queda registrado con su origen y sus destinatarios', async () => {
  await addChange('2026-03-01');

  const outcome = await sendDailyReport({ date: '2026-03-01' });
  assert.equal(outcome.sent, true);

  const attempt = await lastAttempt();
  assert.equal(attempt.report_date, '2026-03-01');
  assert.equal(attempt.outcome, 'enviado');
  assert.equal(attempt.origin, 'automatico', 'el pase programado se marca como automático');
  assert.equal(attempt.changes, 1);
  assert.deepEqual(attempt.recipients, ['destino@example.com']);
});

test('el envío manual se distingue del automático', async () => {
  await addChange('2026-03-02');
  await sendDailyReport({ date: '2026-03-02', force: true, origin: 'manual' });

  const attempt = await lastAttempt();
  assert.equal(attempt.origin, 'manual');
  assert.equal(attempt.outcome, 'enviado');
});

test('un envío que no llega a salir deja escrito el motivo', async () => {
  // Sin trabajadores activos no hay a quién enviar. Es el fallo más fácil de
  // provocar de verdad, sin tocar SMTP ni simular nada.
  await addChange('2026-03-03');
  await updateWorker(worker.id, { active: false });

  const outcome = await sendDailyReport({ date: '2026-03-03' });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'no-active-workers');

  const attempt = await lastAttempt();
  assert.equal(attempt.outcome, 'fallido');
  assert.match(attempt.reason, /trabajadores activos/);
  assert.equal(attempt.report_date, '2026-03-03');

  await updateWorker(worker.id, { active: true });
  assert.equal((await listWorkers({ activeOnly: true })).length, 1);
});

test('un reenvío forzado NO borra lo que pasó en el intento que falló', async () => {
  // Esto es exactamente lo que ocurrió en producción: el botón "Enviar ahora"
  // limpia daily_reports.error, y con él la única explicación que había.
  const sent = await sendDailyReport({ date: '2026-03-03', force: true, origin: 'manual' });
  assert.equal(sent.sent, true, 'el reenvío manual sí sale');

  const forThatDay = (await listAttempts(50)).filter((row) => row.report_date === '2026-03-03');
  assert.equal(forThatDay.length, 2, 'quedan los dos intentos, no solo el bueno');
  assert.deepEqual(
    forThatDay.map((row) => `${row.origin}:${row.outcome}`).sort(),
    ['automatico:fallido', 'manual:enviado'],
    'el fallo automático sigue ahí después del envío manual',
  );
});

test('los intentos se guardan del más reciente al más antiguo', async () => {
  const rows = await listAttempts(50);
  const dates = rows.map((row) => row.attempted_at);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

/* ============ 2) EL DÍA VACÍO Y report_send_when_empty ================== */

test('con report_send_when_empty activado, un día sin cambios sí manda correo', async () => {
  await setSettings({ report_send_when_empty: 'true' });

  const outcome = await sendDailyReport({ date: '2026-04-10' });
  assert.equal(outcome.sent, true, 'sale el correo de "sin cambios"');
  assert.equal(outcome.changes, 0);

  const attempt = await lastAttempt();
  assert.equal(attempt.outcome, 'enviado');
  assert.equal(attempt.changes, 0);
});

test('con report_send_when_empty desactivado, un día sin cambios no manda nada', async () => {
  await setSettings({ report_send_when_empty: 'false' });

  const outcome = await sendDailyReport({ date: '2026-04-11' });
  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'no-changes');

  const attempt = await lastAttempt();
  assert.equal(attempt.outcome, 'omitido');
  assert.match(attempt.reason, /días vacíos/);
});

test('la comprobación acepta las mismas formas que el resto del sistema', async () => {
  // Antes se miraba con .startsWith("t") sobre el texto guardado, así que
  // "1", "on" y "yes" - que getBool sí entiende - apagaban el envío sin querer.
  for (const value of ['1', 'on', 'yes', 'TRUE']) {
    await setSettings({ report_send_when_empty: value });
    const status = await reportStatus();
    assert.equal(status.send_when_empty, true, `"${value}" debe contar como activado`);
  }
  for (const value of ['0', 'off', 'no', 'false']) {
    await setSettings({ report_send_when_empty: value });
    const status = await reportStatus();
    assert.equal(status.send_when_empty, false, `"${value}" debe contar como desactivado`);
  }
  await setSettings({ report_send_when_empty: 'true' });
});

/* ============ 3) LO QUE EL PANEL TIENE QUE PODER DECIR ================== */

test('el estado dice cuándo sale el próximo informe y qué hace con un día vacío', async () => {
  await setSettings({ digest_hour: '7', digest_timezone: 'Europe/Madrid' });

  const status = await reportStatus(new Date('2026-09-17T12:00:00Z'));

  assert.equal(status.hour, 7);
  assert.equal(status.timezone, 'Europe/Madrid');
  assert.equal(status.send_when_empty, true);
  assert.equal(
    status.next_report_at,
    '2026-09-18T05:00:00.000Z',
    'pasada la hora de hoy, el próximo es el de mañana a las 07:00 de Madrid',
  );
  assert.ok(status.last_attempt, 'y el panel puede contar qué pasó la última vez');
  assert.ok(['enviado', 'fallido', 'omitido'].includes(status.last_attempt.outcome));
});

test('antes de la hora, el próximo informe es el de hoy', async () => {
  const status = await reportStatus(new Date('2026-09-17T03:00:00Z'));
  assert.equal(status.next_report_at, '2026-09-17T05:00:00.000Z');
});
