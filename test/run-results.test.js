import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * Los resultados de una comprobación, y Slack como tercer canal.
 *
 * Dos cosas se comprueban aquí por encima de todas las demás.
 *
 * La primera es que un resultado pertenece a UNA ejecución. "Los cambios de
 * las últimas dos horas" es una mezcla: dos pasadas seguidas se pisan y la de
 * ayer desaparece. Con run_id la pregunta tiene respuesta exacta, y estas
 * pruebas la hacen con dos ejecuciones a la vez para que una mezcla no pueda
 * pasar desapercibida.
 *
 * La segunda es que nada de Slack puede tumbar nada. Un webhook ausente, un
 * Slack caído, un reintento de la función: en los tres casos el crawler
 * termina, los resultados salen en el panel y el correo se manda igual. Y el
 * webhook no aparece en ninguna respuesta del API ni en ninguna columna que
 * el panel lea.
 */

const cleanup = useTempDatabase('run-results');
// Como el despliegue real: el panel está abierto, sin login.
process.env.AUTH_PROVIDER = 'none';

const WEBHOOK = 'https://hooks.slack.com/services/T000SECRET/B000SECRET/zzzTOPSECRETzzz';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { config } = await import('../src/config/index.js');
const { createApp } = await import('../src/api/server.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { createWorker } = await import('../src/db/repositories/workers.repo.js');
const { recordChange, changesForRun } = await import('../src/db/repositories/changes.repo.js');
const { startRun, finishRun, getRun, listRuns, expireStaleRuns } = await import(
  '../src/db/repositories/runs.repo.js'
);
const { notifyRunToSlack, buildChangeMessage, postToSlack, scrubSecret, slackConfigured } =
  await import('../src/notifications/slack.js');

await runMigrations({ log: () => {} });

const server = createApp().listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  cleanup();
  config.slack.webhookUrl = '';
});

const call = async (path) => {
  const response = await fetch(base + path);
  return { status: response.status, data: await response.json().catch(() => ({})) };
};

/** Un Slack falso: apunta lo que recibe y contesta lo que se le diga. */
function fakeSlack({ ok = true, status = 200, body = '' } = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return {
        ok,
        status,
        text: async () => body,
      };
    },
  };
}

const website = await createWebsite({
  name: 'Borås Golfklubb',
  url: 'https://boras.example',
  active: true,
  check_interval: 60,
  detection_method: 'html',
  selector_config: {},
});
await createWorker({ name: 'Trabajador', email: 'trabajador@example.com', active: true });

let runA;
let runB;

const relevantChange = (runId, overrides = {}) => ({
  websiteId: website.id,
  runId,
  changeDate: '2026-09-16',
  changeType: 'NEW',
  priority: 'HIGH',
  category: 'TOURNAMENTS',
  draftMessage: 'Hola a todos: se ha convocado el torneo de otoño. Os paso la información.',
  title: 'Höstgolftävling 20 september',
  url: 'https://boras.example/tavling',
  summary: 'Se ha convocado el torneo de otoño.',
  whatChanged: 'Nueva entrada en el listado de competiciones',
  reasoning: 'un torneo',
  ...overrides,
});

const ignoredChange = (runId, overrides = {}) => ({
  websiteId: website.id,
  runId,
  changeDate: '2026-09-16',
  changeType: 'IGNORED',
  priority: 'LOW',
  category: null,
  draftMessage: null,
  title: '25% rabatt i shopen',
  url: 'https://boras.example/rabatt',
  reasoning: '[filtro de relevancia: no encaja en ninguna de las seis categorías]',
  ...overrides,
});

/* ==================================================== 1) LA EJECUCIÓN ==== */

test('una comprobación se abre en curso y se cierra completada', async () => {
  runA = await startRun({ origin: 'manual' });
  assert.equal(runA.status, 'running', 'mientras corre, el panel puede decirlo con algo real detrás');
  assert.equal(runA.origin, 'manual');

  // Lo que encontró esa pasada.
  await recordChange(relevantChange(runA.id));
  await recordChange(relevantChange(runA.id, { changeType: 'UPDATED', priority: 'MEDIUM', category: 'COURSE_INFO', title: 'Banan stängd på lördag' }));
  for (let n = 0; n < 3; n += 1) await recordChange(ignoredChange(runA.id));

  const closed = await finishRun(runA.id, {
    status: 'done',
    websites: 27,
    pagesSeen: 219,
    pagesChanged: 5,
    analyzed: 5,
    relevant: 2,
    ignored: 3,
    drafts: 2,
    websitesFailed: 2,
    durationMs: 55559,
    errors: [
      { website: 'Sundsvall', label: 'No disponible' },
      { website: 'Hagge', label: 'No se ha podido conectar' },
    ],
  });

  assert.equal(closed.status, 'done');
  assert.equal(closed.relevant, 2);
  assert.equal(closed.ignored, 3);
  assert.equal(closed.drafts, 2);
  assert.equal(closed.errors.length, 2, 'los errores se guardan ya traducidos');
  assert.ok(!JSON.stringify(closed.errors).match(/ENOTFOUND|HTTP \d{3}/), 'sin infraestructura');
});

test('los resultados van atados a SU comprobación, no mezclados', async () => {
  // Una segunda pasada, con otro hallazgo. Si los resultados se mezclaran,
  // esto es lo que lo demostraría.
  runB = await startRun({ origin: 'automatico' });
  await recordChange(
    relevantChange(runB.id, {
      category: 'RESTAURANT',
      title: 'Klubbmiddag i restaurangen',
      draftMessage: 'Aviso: cena del club en el restaurante.',
    }),
  );
  await finishRun(runB.id, { status: 'done', websites: 27, relevant: 1, ignored: 0, drafts: 1 });

  const fromA = await changesForRun(runA.id, { types: ['NEW', 'UPDATED'] });
  const fromB = await changesForRun(runB.id, { types: ['NEW', 'UPDATED'] });

  assert.equal(fromA.length, 2, 'la primera conserva sus dos');
  assert.equal(fromB.length, 1, 'la segunda tiene el suyo y sólo el suyo');
  assert.ok(
    !fromA.some((change) => change.title.includes('Klubbmiddag')),
    'lo de la segunda NO aparece en la primera',
  );
  assert.ok(
    !fromB.some((change) => change.title.includes('Höstgolftävling')),
    'ni al revés',
  );
});

/* ================================================== 2) EL PANEL LO VE ==== */

test('el panel recibe los resultados de la comprobación, relevantes aparte de ignorados', async () => {
  const { status, data } = await call(`/api/status/runs/${runA.id}`);
  assert.equal(status, 200);

  assert.equal(data.run.id, runA.id);
  assert.equal(data.run.status, 'done');
  assert.equal(data.run.websites, 27);
  assert.equal(data.run.pages_seen, 219);
  assert.equal(data.run.relevant, 2);
  assert.equal(data.run.ignored, 3);
  assert.equal(data.run.drafts, 2);
  assert.equal(data.run.websites_failed, 2);
  assert.equal(data.run.errors.length, 2);

  // Los relevantes vienen enteros...
  assert.equal(data.relevant.length, 2);
  const torneo = data.relevant.find((change) => change.category === 'TOURNAMENTS');
  assert.ok(torneo, 'el cambio relevante aparece');
  assert.equal(torneo.category, 'TOURNAMENTS', 'conserva su categoría');
  assert.equal(torneo.change_type, 'NEW');
  assert.equal(torneo.priority, 'HIGH');
  assert.match(torneo.draft_message, /torneo de otoño/, 'conserva su borrador');
  assert.equal(torneo.url, 'https://boras.example/tavling', 'y el enlace al original');
  assert.ok(torneo.detected_at, 'con su hora de detección');

  // ...y los ignorados sólo se cuentan.
  assert.equal(data.ignored_count, 3);
  assert.ok(
    !data.relevant.some((change) => change.title.includes('rabatt')),
    'un cambio ignorado NO aparece entre los relevantes',
  );
  assert.ok(
    data.ignored.every((change) => !('draft_message' in change)),
    'ni arrastra borrador',
  );
});

test('/api/status publica la última comprobación para que el panel se entere solo', async () => {
  const { data } = await call('/api/status');
  assert.ok(data.last_run, 'hay una última comprobación');
  assert.equal(data.last_run.id, runB.id, 'la más reciente');
  assert.equal(data.last_run.status, 'done');
});

test('una comprobación que murió sin cerrarse deja de decir "en curso"', async () => {
  const zombie = await startRun({ origin: 'automatico' });
  // Envejecida a mano: en serverless una función puede morir sin ejecutar su
  // cierre, y sin esto el panel giraría una rueda para siempre.
  const { getDb } = await import('../src/db/index.js');
  const db = await getDb();
  await db.run('UPDATE crawl_runs SET started_at = ? WHERE id = ?', [
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    zombie.id,
  ]);

  await expireStaleRuns();
  assert.equal((await getRun(zombie.id)).status, 'failed');

  // Y no se lleva por delante a la que sí está corriendo ahora.
  const live = await startRun({ origin: 'manual' });
  await expireStaleRuns();
  assert.equal((await getRun(live.id)).status, 'running');
  await finishRun(live.id, { status: 'done' });
});

/* ======================================================== 3) SLACK ======= */

test('sin webhook, Slack no existe y nada se rompe', async () => {
  config.slack.webhookUrl = '';
  assert.equal(slackConfigured(), false);

  const outcome = await notifyRunToSlack(runA.id);
  assert.deepEqual(outcome, { configured: false, sent: 0, skipped: 0, failed: 0, errors: [] });

  // Y el resto del sistema sigue entero.
  const { status, data } = await call('/api/status');
  assert.equal(status, 200);
  assert.equal(data.slack.configured, false);
  assert.equal(data.crawler.status !== undefined, true, 'el crawler sigue informando');
  assert.ok(data.report, 'y el informe también');

  const detail = await call(`/api/status/runs/${runA.id}`);
  assert.equal(detail.data.relevant.length, 2, 'los resultados siguen en el panel');
});

test('con webhook, cada cambio relevante se publica una vez', async () => {
  config.slack.webhookUrl = WEBHOOK;
  assert.equal(slackConfigured(), true);

  const slack = fakeSlack();
  const outcome = await notifyRunToSlack(runA.id, { fetchImpl: slack.fetch, gapMs: 0 });

  assert.equal(outcome.configured, true);
  assert.equal(outcome.sent, 2, 'los dos relevantes, y sólo ellos');
  assert.equal(outcome.failed, 0);
  assert.equal(slack.calls.length, 2);

  for (const post of slack.calls) {
    assert.equal(post.url, WEBHOOK, 'va al webhook configurado');
    assert.ok(post.body.blocks?.length, 'con bloques de Slack');
    assert.ok(post.body.text, 'y texto plano para la notificación del móvil');
  }

  const texto = JSON.stringify(slack.calls);
  assert.match(texto, /Höstgolftävling/, 'el torneo se avisó');
  assert.match(texto, /Draft message/, 'con su borrador');
  assert.match(texto, /torneo de oto/, 'y el borrador es el de la IA');
  assert.ok(!texto.includes('rabatt'), 'un cambio IGNORADO nunca llega a Slack');
});

test('reintentar la misma comprobación NO manda duplicados', async () => {
  config.slack.webhookUrl = WEBHOOK;
  const slack = fakeSlack();

  // Segunda vuelta sobre la MISMA ejecución: es lo que pasa si Netlify
  // reintenta la función o si alguien la lanza dos veces.
  const again = await notifyRunToSlack(runA.id, { fetchImpl: slack.fetch, gapMs: 0 });

  assert.equal(again.sent, 0, 'no se manda nada otra vez');
  assert.equal(slack.calls.length, 0, 'ni una sola petición a Slack');

  // Y la de la otra ejecución, que nadie avisó todavía, sí sale.
  const otra = await notifyRunToSlack(runB.id, { fetchImpl: slack.fetch, gapMs: 0 });
  assert.equal(otra.sent, 1, 'lo pendiente sí se avisa');
  assert.equal(slack.calls.length, 1);
});

test('si Slack falla, el cambio queda sin marcar y se puede reintentar', async () => {
  config.slack.webhookUrl = WEBHOOK;

  const run = await startRun({ origin: 'manual' });
  await recordChange(relevantChange(run.id));
  await finishRun(run.id, { status: 'done', relevant: 1 });

  // Slack devuelve un error.
  const roto = fakeSlack({ ok: false, status: 500, body: 'server_error' });
  const fallo = await notifyRunToSlack(run.id, { fetchImpl: roto.fetch, gapMs: 0 });
  assert.equal(fallo.sent, 0);
  assert.equal(fallo.failed, 1);
  assert.match(fallo.errors[0], /500/);

  // El cambio NO se quedó marcado como avisado: la reserva se devolvió.
  const [pendiente] = await changesForRun(run.id, { types: ['NEW'] });
  assert.equal(pendiente.slack_notified_at, null, 'se puede volver a intentar');

  // Y al reintentar con Slack sano, sale. Una vez.
  const sano = fakeSlack();
  const segundo = await notifyRunToSlack(run.id, { fetchImpl: sano.fetch, gapMs: 0 });
  assert.equal(segundo.sent, 1);
  assert.equal(sano.calls.length, 1);
});

test('un Slack caído no impide el correo ni el panel', async () => {
  config.slack.webhookUrl = WEBHOOK;
  const { sendDailyReport } = await import('../src/monitor/report.js');

  const run = await startRun({ origin: 'manual' });
  await recordChange(relevantChange(run.id));
  await finishRun(run.id, { status: 'done', relevant: 1 });

  // Slack revienta con una excepción, no con un 500.
  const explota = {
    fetch: async () => {
      throw new Error('ECONNREFUSED 10.0.0.1:443');
    },
  };
  const fallo = await notifyRunToSlack(run.id, { fetchImpl: explota.fetch, gapMs: 0 });
  assert.equal(fallo.failed, 1, 'Slack falla, y lo dice');

  // El panel sigue enseñando los resultados de esa misma comprobación.
  const { status, data } = await call(`/api/status/runs/${run.id}`);
  assert.equal(status, 200);
  assert.equal(data.relevant.length, 1, 'el panel no se entera del problema de Slack');

  // Y el correo sale igual.
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const email = await sendDailyReport({ date: '2026-09-16', now: new Date('2026-09-17T06:00:00Z') });
    assert.equal(email.sent, true, 'el correo sale aunque Slack esté caído');
  } finally {
    if (key) process.env.ANTHROPIC_API_KEY = key;
  }
});

/* ================================================= 4) EL SECRETO ========= */

test('el webhook no sale del servidor por ninguna puerta', async () => {
  config.slack.webhookUrl = WEBHOOK;

  const rutas = [
    '/api/status',
    '/api/diagnostics',
    `/api/status/runs`,
    `/api/status/runs/${runA.id}`,
    '/api/status/websites-health',
  ];
  for (const ruta of rutas) {
    const { data } = await call(ruta);
    const cuerpo = JSON.stringify(data);
    assert.ok(!cuerpo.includes(WEBHOOK), `${ruta} no filtra el webhook`);
    assert.ok(!cuerpo.includes('TOPSECRET'), `${ruta} no filtra ni un trozo`);
    assert.ok(!cuerpo.includes('hooks.slack.com'), `${ruta} no filtra ni el servidor`);
  }

  // Y /api/status dice que hay canal, sin decir cuál.
  const { data } = await call('/api/status');
  assert.deepEqual(data.slack, { configured: true });
});

test('el webhook no está en el código que se manda al navegador', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../src/web/', import.meta.url);
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(js|html|css|json)$/.test(file)) continue;
    const body = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.ok(!body.includes('SLACK_WEBHOOK'), `${file} no nombra la variable`);
    assert.ok(!body.includes('hooks.slack.com'), `${file} no lleva el webhook`);
    assert.ok(!/localStorage[\s\S]{0,40}slack/i.test(body), `${file} no guarda Slack en el navegador`);
  }
  // Ni en la configuración que sí se publica.
  const publica = fs.readFileSync(new URL('../src/config/public.config.js', import.meta.url), 'utf8');
  assert.ok(!publica.toLowerCase().includes('slack'), 'la configuración que se publica no menciona Slack');
});

test('un error de red no publica el webhook en la fila de la ejecución', async () => {
  // fetch mete la URL entera en el texto de muchos errores de red, y ese
  // texto acaba en crawl_runs.slack_error, que el panel lee. Sin sanear, el
  // secreto se publicaría solo el día que Slack diera un problema.
  config.slack.webhookUrl = WEBHOOK;

  const sucio = `request to ${WEBHOOK} failed, reason: ECONNRESET`;
  const limpio = scrubSecret(sucio);
  assert.ok(!limpio.includes(WEBHOOK));
  assert.ok(!limpio.includes('TOPSECRET'));
  assert.match(limpio, /el webhook de Slack/);
  assert.match(limpio, /ECONNRESET/, 'el motivo sí se conserva');

  // Y el camino real: postToSlack con un fetch que revienta nombrando la URL.
  const result = await postToSlack(
    { text: 'x' },
    {
      fetchImpl: async () => {
        throw new Error(`connect ECONNREFUSED ${WEBHOOK}`);
      },
    },
  );
  assert.equal(result.ok, false);
  assert.ok(!result.reason.includes('TOPSECRET'), 'el motivo que se guarda va limpio');
});

/* ================================================= 5) EL MENSAJE ========= */

test('el mensaje de Slack lleva ficha, borrador y los dos enlaces', () => {
  const message = buildChangeMessage(
    {
      id: 42,
      website_name: 'Borås Golfklubb',
      category: 'TOURNAMENTS',
      change_type: 'NEW',
      priority: 'HIGH',
      title: 'Höstgolftävling 20 september',
      summary: 'Se ha convocado el torneo de otoño.',
      what_changed: 'Nueva entrada en el listado',
      draft_message: 'Hola a todos: se ha convocado el torneo de otoño.',
      url: 'https://boras.example/tavling',
    },
    { baseUrl: 'https://webcrawer.netlify.app' },
  );

  const texto = JSON.stringify(message);
  assert.match(texto, /New/, 'dice que es nuevo');
  assert.match(texto, /Tournaments/, 'y de qué categoría');
  assert.match(texto, /\*Club:\* Borås Golfklubb/);
  assert.match(texto, /\*Priority:\* HIGH/);
  assert.match(texto, /Draft message/);

  const acciones = message.blocks.find((block) => block.type === 'actions');
  const urls = acciones.elements.map((button) => button.url);
  assert.ok(urls.includes('https://boras.example/tavling'), 'enlace a la página original');
  assert.ok(
    urls.some((url) => url.startsWith('https://webcrawer.netlify.app/?change=42')),
    'y botón al cambio en el panel',
  );
});

test('un cambio sin enlace no genera un botón roto', () => {
  const message = buildChangeMessage(
    {
      id: 7,
      website_name: 'Club',
      category: 'COURSE_INFO',
      change_type: 'UPDATED',
      priority: 'MEDIUM',
      title: 'Aviso',
      url: null,
      draft_message: null,
    },
    { baseUrl: 'no-es-una-url' },
  );
  // Slack rechaza el mensaje entero si un botón trae una URL inválida.
  const acciones = message.blocks.find((block) => block.type === 'actions');
  assert.equal(acciones, undefined, 'sin URLs válidas no hay bloque de botones');
  assert.ok(message.text, 'pero el mensaje sigue teniendo texto');
});
