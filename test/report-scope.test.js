import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * De qué clubes habla el correo.
 *
 * El trabajador pidió recibir sólo uno. Lo que se comprueba aquí es que eso
 * es un filtro de ENVÍO y nada más: las demás webs se siguen vigilando, sus
 * cambios se siguen guardando y se siguen viendo en el panel, y el día que
 * vuelvan a la lista el informe los recoge en lugar de haberlos perdido.
 *
 * Esa última parte es la que más importa. Un filtro que además borra es una
 * decisión irreversible tomada por un ajuste temporal.
 */

const cleanup = useTempDatabase('report-scope');
process.env.AUTH_PROVIDER = 'none';
delete process.env.ANTHROPIC_API_KEY;

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { createWorker } = await import('../src/db/repositories/workers.repo.js');
const { recordChange, changesForReport, countPendingForReport, listChanges } = await import(
  '../src/db/repositories/changes.repo.js'
);
const { setSettings } = await import('../src/db/repositories/settings.repo.js');
const { buildReport, sendDailyReport, reportStatus, parseWebsiteScope } = await import(
  '../src/monitor/report.js'
);

await runMigrations({ log: () => {} });

test.after(async () => {
  await closeDb();
  cleanup();
});

const make = (name, url) =>
  createWebsite({
    name,
    url,
    active: true,
    check_interval: 60,
    detection_method: 'html',
    selector_config: {},
  });

const karsta = await make('Kårsta', 'https://www.karstagk.se/');
const boras = await make('Borås', 'https://boras.example');
const vallda = await make('Vallda', 'https://vallda.example');
await createWorker({ name: 'Trabajador', email: 'trabajador@example.com', active: true });

const change = (website, title, overrides = {}) =>
  recordChange({
    websiteId: website.id,
    changeDate: '2026-09-20',
    changeType: 'NEW',
    priority: 'HIGH',
    category: 'TOURNAMENTS',
    draftMessage: `Draft about ${title}.`,
    title,
    url: `${website.url}/x`,
    summary: `Something happened at ${website.name}.`,
    whatChanged: 'A new entry',
    ...overrides,
  });

await change(karsta, 'Kårsta hösttävling');
await change(boras, 'Borås klubbmästerskap');
await change(vallda, 'Vallda banan stängd');

/* ------------------------------------------------- el lector del ajuste */

test('la lista de clubes se lee con tolerancia y vacío significa todos', () => {
  assert.equal(parseWebsiteScope(''), null, 'vacío = todos, como antes de que existiera');
  assert.equal(parseWebsiteScope(null), null);
  assert.equal(parseWebsiteScope('   '), null);
  assert.deepEqual(parseWebsiteScope('13'), [13]);
  assert.deepEqual(parseWebsiteScope(' 13 , 4 '), [13, 4], 'los espacios no cuentan');
  assert.deepEqual(parseWebsiteScope('13,13,4'), [13, 4], 'ni los repetidos');
  assert.equal(parseWebsiteScope('abc'), null, 'basura = todos, nunca "ninguno"');
});

/* ------------------------------------------------------- el filtro real */

test('sin filtro, el informe habla de los tres clubes', async () => {
  await setSettings({ report_websites: '' });
  const changes = await changesForReport({ date: '2026-09-20' });
  assert.equal(changes.length, 3);
});

test('con el filtro, el correo sólo habla de Kårsta', async () => {
  await setSettings({ report_websites: String(karsta.id) });

  const report = await buildReport({ date: '2026-09-20', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 1, 'un solo cambio en el informe');
  assert.equal(report.payload.changes[0].website, 'Kårsta');

  const titles = report.payload.changes.map((c) => c.title).join(' ');
  assert.ok(!titles.includes('Borås'), 'Borås no aparece');
  assert.ok(!titles.includes('Vallda'), 'Vallda tampoco');

  // Y el recuento de webs habla del alcance, no de las 27 vigiladas.
  assert.equal(report.websitesTotal, 1, '"webs sin novedades: x/27" sería mentira');
  assert.equal(report.websitesQuiet, 0);
});

test('el correo que sale no menciona a los demás clubes', async () => {
  await setSettings({ report_websites: String(karsta.id) });
  const outcome = await sendDailyReport({
    date: '2026-09-20',
    now: new Date('2026-09-21T06:00:00Z'),
  });

  assert.equal(outcome.sent, true);
  assert.equal(outcome.changes, 1);

  const { buildReportEmail } = await import('../src/monitor/report.email.js');
  const { getReport } = await import('../src/db/repositories/reports.repo.js');
  const stored = await getReport('2026-09-20');
  const email = buildReportEmail({ ...stored, date: '2026-09-20' }, { timeZone: 'Europe/Madrid' });

  for (const part of [email.text, email.html]) {
    assert.match(part, /Kårsta/, 'Kårsta sí');
    assert.doesNotMatch(part, /Borås/, 'Borås no');
    assert.doesNotMatch(part, /Vallda/, 'Vallda no');
  }
});

/* --------------------------------------- lo que NO hace el filtro */

test('los demás clubes se siguen vigilando y siguen en el panel', async () => {
  // Nada se ha borrado: los tres cambios siguen en la base, enteros.
  const all = await listChanges({ limit: 100 });
  const names = all.map((c) => c.title).join(' ');
  assert.equal(all.length, 3, 'los tres cambios siguen guardados');
  assert.match(names, /Borås klubbmästerskap/);
  assert.match(names, /Vallda banan stängd/);

  const { listWebsites } = await import('../src/db/repositories/websites.repo.js');
  const websites = await listWebsites({ activeOnly: true });
  assert.equal(websites.length, 3, 'las tres webs siguen activas y vigiladas');
});

test('el panel cuenta lo que de verdad se va a enviar, no más', async () => {
  await setSettings({ report_websites: String(karsta.id) });
  const scoped = await countPendingForReport({ date: '2026-09-22', websiteIds: [karsta.id] });
  const everything = await countPendingForReport({ date: '2026-09-22' });

  assert.equal(everything, 2, 'sin filtro quedarían los dos de los otros clubes');
  assert.equal(scoped, 0, 'con filtro, el de Kårsta ya salió y no queda nada');

  const status = await reportStatus(new Date('2026-09-22T06:00:00Z'));
  assert.equal(status.websites_scope, 1, 'el panel sabe que el correo se limita a un club');
  assert.equal(status.pending_changes, 0, 'y no promete cambios que no va a mandar');
});

test('quitar el filtro devuelve los cambios que esperaban, sin perder ninguno', async () => {
  // Esto es lo que hace que el filtro sea reversible: los cambios de los
  // otros clubes no se marcaron como enviados, así que siguen ahí.
  await setSettings({ report_websites: '' });

  const report = await buildReport({ date: '2026-09-22', timeZone: 'Europe/Madrid' });
  const titles = report.payload.changes.map((c) => c.title);

  assert.ok(titles.includes('Borås klubbmästerskap'), 'Borås vuelve');
  assert.ok(titles.includes('Vallda banan stängd'), 'Vallda vuelve');
  assert.ok(!titles.includes('Kårsta hösttävling'), 'y el ya enviado no se repite');
});
