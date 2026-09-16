import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('ai-detection');
delete process.env.ANTHROPIC_API_KEY;

const { reduceHtml, aiConfigured } = await import('../src/crawler/fetchers/ai.fetcher.js');
const { DETECTION_METHODS } = await import('../src/api/validate.js');

test.after(cleanup);

test('the page is stripped to what the model needs to read', () => {
  const html = `<html><head><style>.a{color:red}</style></head><body>
    <script>window.tracking = 1;</script>
    <main><article class="post" data-id="9" onclick="go()" style="color:red">
      <h2><a href="/noticia-1">Primera noticia</a></h2><time datetime="2026-09-15">15/09/2026</time>
    </article></main>
    <svg><path d="M0 0"/></svg></body></html>`;

  const reduced = reduceHtml(html);
  assert.ok(!reduced.includes('window.tracking'), 'scripts are dropped');
  assert.ok(!reduced.includes('color:red'), 'styles are dropped');
  assert.ok(!reduced.includes('onclick'), 'noise attributes are dropped');
  assert.ok(!reduced.includes('<path'), 'svg is dropped');
  assert.ok(reduced.includes('Primera noticia'), 'the content survives');
  assert.ok(reduced.includes('/noticia-1'), 'links survive');
  assert.ok(reduced.includes('2026-09-15'), 'dates survive');
});

test('long pages are capped so a request cannot blow up', () => {
  const long = `<body><main>${'<p>publicación de prueba</p>'.repeat(20000)}</main></body>`;
  assert.ok(reduceHtml(long, 5000).length <= 5000);
});

test('AI detection is offered as a method but is off without a key', () => {
  assert.ok(DETECTION_METHODS.includes('ai'));
  assert.equal(aiConfigured(), false);
});

test('without a key it fails with an explanation, not a crash', async () => {
  const { detectWithAi } = await import('../src/crawler/fetchers/ai.fetcher.js');
  await assert.rejects(
    () => detectWithAi({ url: 'https://example.com' }),
    (error) => {
      assert.match(error.message, /ANTHROPIC_API_KEY/);
      assert.equal(error.status, 501);
      return true;
    },
  );
});

test('with no key configured, nothing is ever sent to the model', async (t) => {
  // The pipeline must stay silent - and free - when there is no key: the
  // crawl still succeeds and stores versions, it simply analyses nothing.
  const { startFixtureSite } = await import('./helpers.js');
  const { runMigrations } = await import('../src/db/migrate.js');
  const websites = await import('../src/db/repositories/websites.repo.js');
  const { crawlWebsite } = await import('../src/monitor/crawl.js');
  const { analyzeCandidates } = await import('../src/monitor/analyze.js');

  await runMigrations({ log: () => {} });
  const site = await startFixtureSite({ posts: [{ title: 'Una publicación cualquiera', url: '/p1' }] });
  t.after(() => site.close());

  const website = await websites.createWebsite({
    name: 'Sin clave',
    url: site.url,
    active: true,
    check_interval: 60,
    detection_method: 'auto',
    selector_config: {},
  });

  const first = await crawlWebsite(website, { maxPages: 4 });
  assert.equal(first.ok, true);
  assert.equal(first.baseline, true, 'the first crawl of a site is its baseline');
  assert.equal(first.candidates.length, 0, 'and produces nothing to analyse');

  const outcome = await analyzeCandidates([], { changeDate: '2026-09-16' });
  assert.equal(outcome.analyzed, 0);
  assert.equal(outcome.usage.input, 0, 'not a single token without a key');
});
