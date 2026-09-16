import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

/**
 * End-to-end over the whole pipeline, against a real HTTP server and a fake
 * Claude. The point is the behaviour the old system got wrong: re-finding an
 * old page is not news, and a cookie banner is not a change.
 */
const cleanup = useTempDatabase('monitor');
process.env.AUTH_PROVIDER = 'none';
process.env.ANTHROPIC_API_KEY = 'test-key-not-used-the-client-is-injected';

const { runMigrations } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/index.js');
const { createWebsite } = await import('../src/db/repositories/websites.repo.js');
const { createWorker } = await import('../src/db/repositories/workers.repo.js');
const { listPages, listVersions } = await import('../src/db/repositories/pages.repo.js');
const { changesForDate, listChanges } = await import('../src/db/repositories/changes.repo.js');
const { runPipeline, changeDateFor } = await import('../src/monitor/index.js');
const { buildReport, sendDailyReport } = await import('../src/monitor/report.js');
const { buildCandidate, batchCandidates } = await import('../src/monitor/analyze.js');

await runMigrations({ log: () => {} });

/** A club site we can edit from the test. */
const site = {
  pages: new Map(),
  listing: [],
};

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  if (path === '/') {
    const links = site.listing
      .map((url) => `<li><a href="${url}">${site.pages.get(url)?.title ?? url}</a></li>`)
      .join('');
    return html(res, `<h1>Klubben</h1><main><ul class="news">${links}</ul></main>`);
  }
  const page = site.pages.get(path);
  if (!page) {
    res.writeHead(404);
    return res.end('not found');
  }
  return html(
    res,
    `<nav class="site-nav">Hem Kontakt Tävling</nav>
     <div class="cookie-banner">${page.cookie ?? 'Vi använder cookies.'}</div>
     <main><article>
       <h1>${page.title}</h1>
       ${page.date ? `<time datetime="${page.date}">${page.date}</time>` : ''}
       <p>${page.body}</p>
     </article></main>
     <footer class="site-footer">Besökare: ${Math.floor(Math.random() * 10_000)}</footer>`,
    page.charset,
  );
});

function html(res, body, charset = 'utf-8') {
  const payload = Buffer.from(`<!doctype html><html><head><title>Klubben</title></head><body>${body}</body></html>`, 'utf8');
  res.writeHead(200, { 'content-type': `text/html; charset=${charset}` });
  res.end(payload);
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await closeDb();
  cleanup();
});

/** A Claude that records what it was asked and answers from a script. */
function fakeClaude(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      async parse(request) {
        calls.push(request);
        const prompt = request.messages[0].content;
        return {
          model: request.model,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 800 },
          parsed_output: reply(prompt, request),
        };
      },
    },
  };
}

const verdictsFor = (prompt, make) => {
  const ids = [...prompt.matchAll(/<candidato id="([^"]+)">/g)].map((match) => match[1]);
  return { verdicts: ids.map((id) => make(id, prompt)) };
};

const verdict = (id, overrides = {}) => ({
  id,
  change_type: 'UPDATED',
  priority: 'MEDIUM',
  title: 'Titel',
  summary: 'Resumen',
  what_changed: 'Algo',
  previous_value: '',
  new_value: '',
  reasoning: 'porque sí',
  ...overrides,
});

let website;

test('the first crawl of a website is a baseline and reports nothing', async () => {
  website = await createWebsite({
    name: 'Albatross',
    url: base,
    active: true,
    check_interval: 60,
    detection_method: 'html',
    selector_config: { list: 'ul.news li', title: 'a', link: 'a' },
  });
  await createWorker({ name: 'Trabajador', email: 'worker@example.com', active: true });

  site.pages.set('/nyhet-2025', {
    title: 'Klubbmästerskap 2025',
    date: '2025-06-14',
    body:
      'Välkommen till klubbmästerskapet 2025. Tävlingen spelas över två dagar på ' +
      'vår bana och är öppen för alla medlemmar i klubben. Anmälan sker via kansliet ' +
      'senast en vecka före start. Evenemanget äger rum den 12 oktober.',
  });
  site.listing = ['/nyhet-2025'];

  const claude = fakeClaude((prompt) => verdictsFor(prompt, (id) => verdict(id)));
  const run = await runPipeline({ client: claude, now: new Date('2026-09-15T21:00:00Z') });

  assert.equal(run.crawl.websites, 1);
  assert.equal(run.crawl.candidates, 0, 'a baseline produces no candidates');
  assert.equal(claude.calls.length, 0, 'and therefore costs nothing');

  const pages = await listPages({ websiteId: website.id });
  assert.equal(pages.length, 2, 'the listing and the article are both tracked');
  for (const page of pages) assert.ok(page.text_hash, 'each page has a stored version');
});

test('a crawl that changes nothing sends nothing to the model', async () => {
  const claude = fakeClaude((prompt) => verdictsFor(prompt, (id) => verdict(id)));
  const run = await runPipeline({ client: claude, now: new Date('2026-09-16T05:00:00Z') });

  assert.equal(run.crawl.pagesChanged, 0, 'identical text is not a change');
  assert.equal(claude.calls.length, 0, 'zero tokens on a quiet day');
});

test('a rotating visitor counter and a new cookie text are not a change', async () => {
  // The footer counter is random on every request and the cookie banner
  // changes wording: both are stripped before anything is hashed.
  site.pages.get('/nyhet-2025').cookie = 'Denna webbplats använder kakor för statistik.';

  const claude = fakeClaude((prompt) => verdictsFor(prompt, (id) => verdict(id)));
  const run = await runPipeline({ client: claude, now: new Date('2026-09-16T09:00:00Z') });

  assert.equal(run.crawl.pagesChanged, 0);
  assert.equal(claude.calls.length, 0);
});

test('re-finding a 2025 article in 2026 is UNCHANGED, not NEW', async () => {
  // This is the bug the rebuild exists for. The URL is new to the crawler,
  // the page says it was published in 2025, and the model is told both.
  site.pages.set('/nyhet-2025-gammal', {
    title: 'Banan öppnar för säsongen',
    date: '2025-04-02',
    body:
      'Banan öppnade den 2 april 2025 efter vintern. Greenerna är i gott skick och ' +
      'sommargreener används från och med denna vecka. Vi påminner om att bokning ' +
      'av starttid görs i systemet som vanligt och att drivingrangen nu är öppen.',
  });
  site.listing = ['/nyhet-2025', '/nyhet-2025-gammal'];

  let sawTheWarning = false;
  let sawTheDate = false;
  const claude = fakeClaude((prompt) => {
    sawTheWarning = prompt.includes('esto NO implica que sea nueva');
    sawTheDate = prompt.includes('2025-04-02');
    return verdictsFor(prompt, (id) =>
      verdict(id, { change_type: 'UNCHANGED', priority: 'LOW', summary: '', what_changed: '' }),
    );
  });

  const run = await runPipeline({ client: claude, now: new Date('2026-09-16T10:00:00Z') });

  assert.equal(run.crawl.candidates, 2, 'the new URL and the changed listing');
  assert.ok(sawTheWarning, 'the model is told that a first sighting is not a publication');
  assert.ok(sawTheDate, 'and is given the date the page declares about itself');

  const reportable = await changesForDate('2026-09-16');
  assert.equal(reportable.length, 0, 'an UNCHANGED verdict never reaches the report');

  const all = await listChanges({});
  assert.ok(all.some((row) => row.change_type === 'UNCHANGED'), 'but it is stored for the audit');
});

test('an edited date is UPDATED, with before and after captured', async () => {
  site.pages.get('/nyhet-2025').body =
    'Välkommen till klubbmästerskapet 2025. Tävlingen spelas över två dagar på ' +
    'vår bana och är öppen för alla medlemmar i klubben. Anmälan sker via kansliet ' +
    'senast en vecka före start. Evenemanget äger rum den 19 oktober.';

  const claude = fakeClaude((prompt) =>
    verdictsFor(prompt, (id) =>
      prompt.includes('19 oktober')
        ? verdict(id, {
            change_type: 'UPDATED',
            priority: 'HIGH',
            title: 'Cambio de fecha del campeonato',
            summary: 'El campeonato del club pasa del 12 al 19 de octubre.',
            what_changed: 'La fecha del evento en el cuerpo de la noticia',
            previous_value: '12 de octubre',
            new_value: '19 de octubre',
          })
        : verdict(id, { change_type: 'IGNORED', priority: 'LOW' }),
    ),
  );

  await runPipeline({ client: claude, now: new Date('2026-09-16T21:00:00Z') });

  const changes = await changesForDate('2026-09-16');
  const updated = changes.find((change) => change.change_type === 'UPDATED');
  assert.ok(updated, 'the edit is reportable');
  assert.equal(updated.priority, 'HIGH');
  assert.equal(updated.previous_value, '12 de octubre');
  assert.equal(updated.new_value, '19 de octubre');
  assert.ok(updated.analysis_input, 'the exact input to the model is stored');
  assert.ok(updated.analysis_output, 'and so is its answer');
  assert.equal(updated.model, 'claude-opus-5');
});

test('the model only ever sees the diff, not the whole page', async () => {
  const [page] = (await listPages({ websiteId: website.id })).filter((row) =>
    row.url.endsWith('/nyhet-2025'),
  );
  const versions = await listVersions(page.id, 5);
  assert.ok(versions.length >= 2, 'the page has a history to compare against');

  const candidate = await buildCandidate({
    pageId: page.id,
    websiteId: website.id,
    websiteName: 'Albatross',
    url: page.url,
    versionId: versions[0].id,
    previousVersionId: versions[1].id,
  });

  assert.ok(candidate.text.includes('CAMBIOS'), 'a diff, not a document');
  assert.ok(candidate.text.includes('+ '), 'with the new lines marked');
  assert.ok(candidate.text.length < 2000, 'and small enough to be cheap');
});

test('UTF-8 survives from the page to the stored version', async () => {
  const pages = await listPages({ websiteId: website.id });
  const swedish = pages.find((page) => page.title?.includes('Banan'));
  assert.ok(swedish, 'the Swedish title was stored');
  assert.ok(!swedish.title.includes('Ã'), `no mojibake in "${swedish.title}"`);

  const [version] = await listVersions(swedish.id, 1);
  const { getVersion } = await import('../src/db/repositories/pages.repo.js');
  const full = await getVersion(version.id);
  assert.match(full.text, /öppnade/, 'and the body keeps its ö');
});

test('the daily report covers one day and counts the quiet websites', async () => {
  const report = await buildReport({ date: '2026-09-16', timeZone: 'Europe/Madrid' });

  assert.equal(report.report_date, '2026-09-16');
  assert.equal(report.total_changes, report.payload.changes.length);
  assert.ok(report.high_priority >= 1, 'the date change is counted as high priority');
  assert.equal(report.websitesTotal, 1);
  assert.ok(report.payload.daily_summary, 'the report carries its summary paragraph');

  // Requirement 7: this exact shape.
  for (const key of ['date', 'total_changes', 'high_priority', 'medium_priority', 'low_priority', 'changes', 'daily_summary']) {
    assert.ok(key in report.payload, `payload.${key}`);
  }
  for (const change of report.payload.changes) {
    for (const key of ['website', 'url', 'type', 'priority', 'title', 'summary', 'what_changed', 'previous_value', 'new_value']) {
      assert.ok(key in change, `change.${key}`);
    }
    assert.ok(['NEW', 'UPDATED'].includes(change.type), 'only NEW and UPDATED are reported');
  }
});

test('a day with no changes produces an empty report, not yesterday\'s', async () => {
  const report = await buildReport({ date: '2026-09-14', timeZone: 'Europe/Madrid' });
  assert.equal(report.total_changes, 0);
  assert.equal(report.payload.changes.length, 0);
});

test('exactly one email goes out per day', async () => {
  const first = await sendDailyReport({ date: '2026-09-16' });
  assert.equal(first.sent, true);
  assert.deepEqual(first.recipients, ['worker@example.com']);

  const second = await sendDailyReport({ date: '2026-09-16' });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already-sent', 'a second scheduler tick cannot resend it');
});

test('a change is dated by when it could have happened, not by the clock', () => {
  // The 07:00 run is comparing against last night, so what it finds belongs
  // to yesterday - which is the day the morning report covers.
  assert.equal(
    changeDateFor(
      { observedSince: '2026-09-15T21:00:00Z' },
      { timeZone: 'Europe/Madrid', runAt: '2026-09-16T05:00:00Z' },
    ),
    '2026-09-15',
  );
  // With nothing to compare against, the run's own day is all we have.
  assert.equal(
    changeDateFor({ observedSince: null }, { timeZone: 'Europe/Madrid', runAt: '2026-09-16T05:00:00Z' }),
    '2026-09-16',
  );
});

test('candidates are batched so one call cannot grow without bound', () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `c${index}`, text: 'x'.repeat(5000) }));
  const batches = batchCandidates(many, { maxPerCall: 6, maxCharsPerCall: 24_000 });
  assert.ok(batches.length >= 4);
  for (const batch of batches) {
    assert.ok(batch.length <= 6);
    assert.ok(batch.reduce((sum, item) => sum + item.text.length, 0) <= 29_000);
  }
});

test('one broken website does not stop the others', async () => {
  const dead = await createWebsite({
    name: 'Caída',
    url: 'http://127.0.0.1:1/nope',
    active: true,
    check_interval: 60,
    detection_method: 'html',
    selector_config: {},
  });

  const claude = fakeClaude((prompt) => verdictsFor(prompt, (id) => verdict(id, { change_type: 'IGNORED' })));
  const run = await runPipeline({ client: claude, now: new Date('2026-09-17T05:00:00Z') });

  assert.equal(run.crawl.failed, 1, 'the dead site is recorded as failed');
  assert.ok(
    run.results.some((result) => result.websiteId === website.id && result.ok),
    'and the working one still ran',
  );
  assert.ok(run.results.find((result) => result.websiteId === dead.id).error);
});
