import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * El filtro de relevancia: qué llega al informe y qué se queda fuera.
 *
 * Dos capas, y las dos importan por razones distintas.
 *
 * La primera es `applyRelevance`, que es código puro: dado un veredicto,
 * decide. Se prueba entera, con las diez situaciones que se pidieron, sin
 * gastar un token y sin depender de que el modelo tenga un buen día. Es el
 * candado: aunque un día el modelo devuelva algo raro, nada sin categoría
 * puede colarse en un correo.
 *
 * La segunda es el prompt, porque el candado no sirve de nada si nadie le ha
 * explicado al modelo qué son las seis categorías. Ahí no se puede afirmar
 * "un torneo sale como TOURNAMENTS" sin llamar a la API de verdad, así que lo
 * que se comprueba es lo que sí es comprobable: que las seis categorías y los
 * cuatro ejemplos de lo que hay que ignorar siguen estando en las
 * instrucciones. Si alguien las borra, esta prueba se entera.
 */

const cleanup = useTempDatabase('relevance');
process.env.ANTHROPIC_API_KEY = 'test-key-not-used-the-client-is-injected';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { upsertPage, recordCapture } = await import('../src/db/repositories/pages.repo.js');
const { listChanges } = await import('../src/db/repositories/changes.repo.js');
const {
  ANALYSIS_SYSTEM_PROMPT,
  RELEVANT_CATEGORIES,
  analyzeCandidates,
  applyRelevance,
  categoryLabel,
} = await import('../src/monitor/analyze.js');
const { dayWindow } = await import('../src/monitor/window.js');
const { buildReportEmail } = await import('../src/monitor/report.email.js');

await runMigrations({ log: () => {} });

test.after(async () => {
  await closeDb();
  cleanup();
});

/* ------------------------------------------------------------------ casos */

/**
 * Las diez situaciones del encargo, más las cuatro secciones del club por
 * separado. `category` es lo que devuelve el modelo; `relevant` es lo que el
 * sistema tiene que hacer con ello.
 */
const CASES = [
  { key: 'tournament', title: 'Höstgolftävling 20 september', category: 'TOURNAMENTS', relevant: true },
  { key: 'news', title: 'Klubben inviger den nya puttinggreenen', category: 'NEWS_EVENTS', relevant: true },
  { key: 'practice', title: 'Golflektioner i oktober', category: 'PRACTICE', relevant: true },
  { key: 'restaurant', title: 'Klubbmiddag i restaurangen', category: 'RESTAURANT', relevant: true },
  { key: 'men', title: 'Herrsektionens nya seriespel', category: 'CLUB_SECTIONS', relevant: true },
  { key: 'women', title: 'Nytt evenemang för damsektionen', category: 'CLUB_SECTIONS', relevant: true },
  { key: 'junior', title: 'Juniorernas träningsläger', category: 'CLUB_SECTIONS', relevant: true },
  { key: 'senior', title: 'Seniorgolfen startar igen', category: 'CLUB_SECTIONS', relevant: true },
  { key: 'course', title: 'Banan stängd på lördag för underhåll', category: 'COURSE_INFO', relevant: true },
  { key: 'discount', title: '25% rabatt i shopen', category: 'NONE', relevant: false },
  { key: 'weather', title: 'Väderprognos för lördag', category: 'NONE', relevant: false },
  { key: 'followers', title: 'Facebook-följare 12 430 till 12 500', category: 'NONE', relevant: false },
  { key: 'cosmetic', title: 'Ny bild på startsidan', category: 'NONE', relevant: false },
];

const draftFor = (key) => `Hola a todos: novedad del club relacionada con ${key}. Os la paso por si queréis verla.`;

const verdictFor = (testCase, id) => ({
  id,
  change_type: 'UPDATED',
  priority: testCase.relevant ? 'HIGH' : 'LOW',
  title: testCase.title,
  summary: `Resumen de ${testCase.key}`,
  what_changed: 'El texto de la página',
  previous_value: '',
  new_value: '',
  reasoning: `clasificado como ${testCase.category}`,
  category: testCase.category,
  // El modelo devuelve borrador incluso cuando no toca: así se comprueba que
  // quien lo borra es el filtro, no la buena voluntad del modelo.
  draft_message: draftFor(testCase.key),
});

/* ------------------------------------------- capa 1: la decisión, en código */

for (const testCase of CASES.filter((c) => c.relevant)) {
  test(`${testCase.key} → relevante (${testCase.category}) y con borrador`, () => {
    const decided = applyRelevance(verdictFor(testCase, 'c1v2'));

    assert.equal(decided.change_type, 'UPDATED', 'sigue siendo reportable');
    assert.equal(decided.category, testCase.category);
    assert.equal(decided.priority, 'HIGH', 'conserva la prioridad que decidió el modelo');
    assert.equal(decided.draft_message, draftFor(testCase.key), 'conserva el borrador');
  });
}

for (const testCase of CASES.filter((c) => !c.relevant)) {
  test(`${testCase.key} → ignorado, sin categoría y sin borrador`, () => {
    const decided = applyRelevance(verdictFor(testCase, 'c1v2'));

    assert.equal(decided.change_type, 'IGNORED', 'un UPDATED sin categoría baja a IGNORED');
    assert.equal(decided.category, null);
    assert.equal(decided.priority, 'LOW', 'y pierde la prioridad');
    assert.equal(decided.draft_message, null, 'lo que no se informa no se redacta');
    assert.match(decided.reasoning, /filtro de relevancia/, 'y queda escrito por qué');
  });
}

test('una categoría inventada por el modelo no cuela', () => {
  const decided = applyRelevance(verdictFor({ key: 'x', category: 'SHOP_OFFERS', relevant: true }, 'c1v2'));
  assert.equal(decided.change_type, 'IGNORED');
  assert.equal(decided.category, null);
});

test('un veredicto que ya era UNCHANGED o IGNORED nunca lleva borrador', () => {
  for (const type of ['UNCHANGED', 'IGNORED']) {
    const decided = applyRelevance({
      id: 'c1v2',
      change_type: type,
      priority: 'LOW',
      category: 'TOURNAMENTS',
      draft_message: 'esto no debería salir jamás',
      reasoning: 'nada relevante',
    });
    assert.equal(decided.change_type, type, 'no se reescribe lo que ya estaba descartado');
    assert.equal(decided.draft_message, null);
    assert.equal(decided.category, null);
  }
});

test('un borrador que llega vacío o en blanco se guarda como ausente, no como ""', () => {
  for (const blank of ['', '   ', '\n', undefined]) {
    const decided = applyRelevance({
      id: 'c1v2',
      change_type: 'NEW',
      priority: 'HIGH',
      category: 'TOURNAMENTS',
      draft_message: blank,
      reasoning: 'un torneo',
    });
    assert.equal(decided.category, 'TOURNAMENTS', 'el cambio sigue siendo relevante');
    assert.equal(decided.draft_message, null);
  }
});

/* ------------------------------------------ capa 2: lo que sabe el modelo */

test('las instrucciones enseñan las seis categorías y qué hay que ignorar', () => {
  for (const category of RELEVANT_CATEGORIES) {
    assert.ok(ANALYSIS_SYSTEM_PROMPT.includes(category), `el prompt define ${category}`);
  }
  // Los cuatro falsos positivos que se pidieron evitar, por su nombre.
  for (const word of ['Descuentos', 'seguidores', 'meteorológica', 'visuales']) {
    assert.match(ANALYSIS_SYSTEM_PROMPT, new RegExp(word, 'i'), `el prompt descarta ${word}`);
  }
  // Y que la decisión es por contenido, no por palabras sueltas.
  assert.match(ANALYSIS_SYSTEM_PROMPT, /JUZGA EL CONTENIDO, NO LAS PALABRAS/);
  assert.match(ANALYSIS_SYSTEM_PROMPT, /No inventes NUNCA fechas, horas, precios, nombres, enlaces/);
  // Las cuatro secciones del club, que es lo que distingue CLUB_SECTIONS.
  assert.match(ANALYSIS_SYSTEM_PROMPT, /masculina, femenina, junior o senior/);
});

test('cada categoría tiene una etiqueta legible y NONE no la tiene', () => {
  for (const category of RELEVANT_CATEGORIES) {
    const label = categoryLabel(category);
    assert.ok(label?.label, `${category} se puede escribir en un correo`);
  }
  assert.equal(categoryLabel('NONE'), null);
  assert.equal(categoryLabel(null), null);
});

test('el panel y el servidor usan la misma lista de categorías', async () => {
  // El navegador no puede importar del servidor, así que la lista está
  // duplicada en app.js. Duplicada es aceptable; desincronizada no.
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
  const block = app.match(/const CATEGORIES = \{([\s\S]*?)\};/)[1];
  const inBrowser = [...block.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]);
  assert.deepEqual(inBrowser.sort(), [...RELEVANT_CATEGORIES].sort());
});

/* --------------------------------------- capa 3: el pipeline de verdad */

/** Un Claude falso que contesta por candidato según el guion de CASES. */
function fakeClaude(byId) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(request) {
        calls.push(request);
        const prompt = request.messages[0].content;
        const ids = [...prompt.matchAll(/<candidato id="([^"]+)">/g)].map((match) => match[1]);
        return {
          model: request.model,
          stop_reason: 'end_turn',
          usage: { input_tokens: 900, output_tokens: 240, cache_read_input_tokens: 400 },
          parsed_output: { verdicts: ids.map((id) => verdictFor(byId.get(id), id)) },
        };
      },
    },
  };
}

const LONG_BEFORE =
  'Välkommen till klubben. Här hittar du information om verksamheten under säsongen ' +
  'och kontaktuppgifter till kansliet om du har frågor om medlemskap eller bokning.';

test('una pasada completa: sólo lo relevante queda como reportable', async (t) => {
  const website = await createWebsite({
    name: 'Klubben',
    url: 'https://klubben.example',
    active: true,
    check_interval: 60,
    detection_method: 'html',
    selector_config: {},
  });

  const byId = new Map();
  const candidates = [];

  for (const testCase of CASES) {
    const url = `https://klubben.example/${testCase.key}`;
    const { page } = await upsertPage({ websiteId: website.id, url, title: testCase.title, source: 'test' });

    // Primera captura: la línea base. Segunda: el cambio que se analiza.
    await recordCapture(page, {
      title: 'Portada',
      text: LONG_BEFORE,
      textHash: `before-${testCase.key}`,
      charCount: LONG_BEFORE.length,
    });
    const after = `${LONG_BEFORE}\n\n${testCase.title}. ${'Detalj om nyheten. '.repeat(6)}`;
    const capture = await recordCapture(page, {
      title: testCase.title,
      text: after,
      textHash: `after-${testCase.key}`,
      charCount: after.length,
    });

    const candidate = {
      pageId: page.id,
      websiteId: website.id,
      websiteName: 'Klubben',
      url,
      title: testCase.title,
      versionId: capture.version.id,
      previousVersionId: capture.previous.id,
    };
    candidates.push(candidate);
    byId.set(`c${page.id}v${capture.version.id}`, testCase);
  }

  const claude = fakeClaude(byId);
  const outcome = await analyzeCandidates(candidates, {
    window: dayWindow('2026-09-16', 'Europe/Madrid'),
    changeDate: '2026-09-16',
    client: claude,
  });

  const expectedRelevant = CASES.filter((c) => c.relevant).length;
  const expectedDropped = CASES.length - expectedRelevant;

  assert.equal(outcome.analyzed, CASES.length, 'el modelo juzgó todos los candidatos');
  assert.equal(outcome.reported, expectedRelevant, `${expectedRelevant} entran en el informe`);
  assert.equal(outcome.filtered, expectedDropped, `${expectedDropped} los descartó el filtro`);

  // Y lo que quedó guardado, fila a fila.
  const stored = await listChanges({ websiteId: website.id, limit: 100 });
  const byTitle = new Map(stored.map((row) => [row.title, row]));

  for (const testCase of CASES) {
    const row = byTitle.get(testCase.title);
    assert.ok(row, `${testCase.key} quedó registrado`);

    if (testCase.relevant) {
      assert.equal(row.change_type, 'UPDATED', `${testCase.key} es reportable`);
      assert.equal(row.category, testCase.category, `${testCase.key} guarda su categoría`);
      assert.equal(row.draft_message, draftFor(testCase.key), `${testCase.key} guarda su borrador`);
    } else {
      assert.equal(row.change_type, 'IGNORED', `${testCase.key} no llega al informe`);
      assert.equal(row.category, null, `${testCase.key} no tiene categoría`);
      assert.equal(row.draft_message, null, `${testCase.key} NO genera borrador`);
    }
  }

  t.diagnostic(`${claude.calls.length} llamada(s) a Claude para ${CASES.length} candidatos`);
});

test('todo se resolvió en las llamadas del análisis: ni una extra por el borrador', async () => {
  // Trece candidatos entran en tres lotes de seis, seis y uno. Lo que importa
  // no es el número exacto sino que el borrador viaja dentro del veredicto:
  // si hiciera falta una llamada por cambio relevante, serían nueve más.
  const byId = new Map();
  const claude = fakeClaude(byId);
  const website = await createWebsite({
    name: 'Segunda',
    url: 'https://segunda.example',
    active: true,
    check_interval: 60,
    detection_method: 'html',
    selector_config: {},
  });

  const relevantes = CASES.filter((c) => c.relevant).slice(0, 3);
  const candidates = [];
  for (const testCase of relevantes) {
    const url = `https://segunda.example/${testCase.key}`;
    const { page } = await upsertPage({ websiteId: website.id, url, title: testCase.title, source: 'test' });
    await recordCapture(page, {
      title: 'Portada',
      text: LONG_BEFORE,
      textHash: `b2-${testCase.key}`,
      charCount: LONG_BEFORE.length,
    });
    const after = `${LONG_BEFORE}\n\n${testCase.title}. ${'Mer text om detta. '.repeat(6)}`;
    const capture = await recordCapture(page, {
      title: testCase.title,
      text: after,
      textHash: `a2-${testCase.key}`,
      charCount: after.length,
    });
    candidates.push({
      pageId: page.id,
      websiteId: website.id,
      websiteName: 'Segunda',
      url,
      title: testCase.title,
      versionId: capture.version.id,
      previousVersionId: capture.previous.id,
    });
    byId.set(`c${page.id}v${capture.version.id}`, testCase);
  }

  const outcome = await analyzeCandidates(candidates, {
    window: dayWindow('2026-09-16', 'Europe/Madrid'),
    changeDate: '2026-09-16',
    client: claude,
  });

  assert.equal(outcome.reported, 3);
  assert.equal(outcome.batches, 1, 'tres candidatos caben en un solo lote');
  assert.equal(claude.calls.length, 1, 'una llamada, con clasificación y borradores dentro');
});

/* ------------------------------------------------- capa 4: el correo */

test('el correo lleva el borrador y la categoría de cada cambio relevante', () => {
  const report = {
    date: '2026-09-16',
    total_changes: 2,
    high_priority: 1,
    websitesQuiet: 25,
    websitesTotal: 27,
    daily_summary: 'Dos novedades en el club.',
    payload: {
      changes: [
        {
          website: 'Klubben',
          url: 'https://klubben.example/tournament',
          type: 'NEW',
          priority: 'HIGH',
          category: 'TOURNAMENTS',
          title: 'Höstgolftävling 20 september',
          summary: 'Se ha convocado el torneo de otoño.',
          what_changed: 'Nueva entrada en el listado de competiciones',
          previous_value: '',
          new_value: '',
          draft_message: 'Hola a todos: se ha convocado el torneo de otoño. Os dejo el enlace con los detalles.',
          change_date: '2026-09-16',
        },
        {
          website: 'Klubben',
          url: 'https://klubben.example/course',
          type: 'UPDATED',
          priority: 'MEDIUM',
          category: 'COURSE_INFO',
          title: 'Banan stängd på lördag',
          summary: 'El campo cierra el sábado por mantenimiento.',
          what_changed: 'Aviso nuevo en la portada',
          previous_value: '',
          new_value: '',
          draft_message: 'Aviso: el campo estará cerrado el sábado por trabajos de mantenimiento.',
          change_date: '2026-09-16',
        },
      ],
    },
  };

  const email = buildReportEmail(report, { timeZone: 'Europe/Madrid' });

  for (const part of [email.text, email.html]) {
    assert.match(part, /Torneo/, 'la categoría se lee en el correo');
    assert.match(part, /Estado del campo/);
    assert.match(part, /Mensaje borrador/i, 'y el borrador está etiquetado');
    assert.match(part, /se ha convocado el torneo de otoño/i);
    assert.match(part, /el campo estará cerrado el sábado/i);
  }
});

test('un cambio sin borrador no deja un hueco con la etiqueta vacía', () => {
  const email = buildReportEmail(
    {
      date: '2026-09-16',
      total_changes: 1,
      websitesQuiet: 26,
      websitesTotal: 27,
      daily_summary: 'Una novedad.',
      payload: {
        changes: [
          {
            website: 'Klubben',
            url: 'https://klubben.example/news',
            type: 'UPDATED',
            priority: 'MEDIUM',
            category: 'NEWS_EVENTS',
            title: 'Una noticia antigua sin borrador',
            summary: 'Registrada antes de que existieran los borradores.',
            what_changed: 'Texto',
            previous_value: '',
            new_value: '',
            draft_message: null,
            change_date: '2026-09-16',
          },
        ],
      },
    },
    { timeZone: 'Europe/Madrid' },
  );

  assert.match(email.text, /Una noticia antigua sin borrador/, 'el cambio sale igual');
  assert.doesNotMatch(email.text, /Mensaje borrador/i, 'sin etiqueta huérfana');
  assert.doesNotMatch(email.html, /Mensaje borrador/i);
});

/* ------------------------------ capa 5: el informe sigue saliendo */

test('el informe se construye y se envía, y lleva los borradores dentro', async () => {
  const { createWorker } = await import('../src/db/repositories/workers.repo.js');
  const { sendDailyReport } = await import('../src/monitor/report.js');
  const { getReport } = await import('../src/db/repositories/reports.repo.js');

  await createWorker({ name: 'Trabajador', email: 'trabajador@example.com', active: true });

  // Sin clave, el párrafo de apertura se redacta sin llamar a nadie: esta
  // prueba mide el informe, no la conexión con la API.
  const key = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    const outcome = await sendDailyReport({
      date: '2026-09-16',
      now: new Date('2026-09-17T05:10:00Z'),
    });

    assert.equal(outcome.sent, true, 'el correo sale');
    assert.deepEqual(outcome.recipients, ['trabajador@example.com']);

    const stored = await getReport('2026-09-16');
    const changes = stored.payload.changes;

    assert.equal(changes.length, outcome.changes);
    assert.ok(changes.length >= 9, `lleva los cambios relevantes (${changes.length})`);

    // Y ni uno solo de los descartados: si el filtro fallara, aquí habría
    // descuentos, meteorología y contadores de Facebook.
    for (const change of changes) {
      assert.ok(RELEVANT_CATEGORIES.includes(change.category), `${change.title} tiene categoría`);
      assert.ok(change.draft_message, `${change.title} lleva su borrador`);
    }
    for (const rejected of ['rabatt', 'Väderprognos', 'Facebook-följare', 'Ny bild']) {
      assert.ok(
        !changes.some((change) => change.title.includes(rejected)),
        `${rejected} no llegó al informe`,
      );
    }

    // Y el correo que se envió de verdad los enseña.
    const email = buildReportEmail({ ...stored, date: '2026-09-16' }, { timeZone: 'Europe/Madrid' });
    assert.match(email.text, /Mensaje borrador/);
    assert.match(email.html, /Mensaje borrador/);
    assert.doesNotMatch(email.text, /rabatt|Väderprognos|Facebook-följare/);
  } finally {
    process.env.ANTHROPIC_API_KEY = key;
  }
});
