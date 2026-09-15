import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDatabase } from './helpers.js';

const cleanup = useTempDatabase('detection');
const { parseFeed } = await import('../src/crawler/fetchers/rss.fetcher.js');
const { extractFromHtml, discoverFeeds } = await import('../src/crawler/fetchers/html.fetcher.js');
const { canonicalUrl, contentHash, parseDate } = await import('../src/crawler/normalize.js');

test.after(cleanup);

test('parses RSS 2.0 items', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>New tournament announced</title><link>https://ffsp.info/example</link>
    <guid>https://ffsp.info/example</guid><pubDate>Tue, 15 Sep 2026 16:42:00 GMT</pubDate></item>
  </channel></rss>`;
  const items = parseFeed(xml, 'https://ffsp.info');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'New tournament announced');
  assert.equal(items[0].url, 'https://ffsp.info/example');
  assert.match(items[0].publishedAt, /^2026-09-15/);
});

test('parses Atom entries with link/@href', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Atom post</title><link rel="alternate" href="https://example.com/a"/>
    <id>tag:example.com,2026:a</id><updated>2026-09-15T10:00:00Z</updated></entry></feed>`;
  const items = parseFeed(xml, 'https://example.com');
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/a');
});

test('extracts publications from HTML with and without selectors', () => {
  const html = `<html><body><main>
    <article class="post"><h2><a href="/noticia-1">Primera noticia del club</a></h2><time datetime="2026-09-15">15/09/2026</time></article>
    <article class="post"><h2><a href="/noticia-2">Segunda noticia del club</a></h2></article>
  </main></body></html>`;

  const auto = extractFromHtml(html, 'https://ffsp.info', {});
  assert.equal(auto.length, 2);
  assert.equal(auto[0].url, 'https://ffsp.info/noticia-1');

  const configured = extractFromHtml(html, 'https://ffsp.info', { list: 'article.post', title: 'h2 a', link: 'a', date: 'time' });
  assert.equal(configured.length, 2);
  assert.equal(configured[1].title, 'Segunda noticia del club');
});

test('discovers a declared RSS feed', () => {
  const html = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed"></head><body></body></html>';
  assert.deepEqual(discoverFeeds(html, 'https://ffsp.info'), ['https://ffsp.info/feed']);
});

test('content hash ignores tracking params and trailing slashes', () => {
  const a = contentHash({ url: 'https://ffsp.info/example/?utm_source=x' });
  const b = contentHash({ url: 'https://ffsp.info/example' });
  assert.equal(a, b);
  assert.equal(canonicalUrl('https://FFSP.info/example/#top'), 'https://ffsp.info/example');
});

test('parses dd/mm/yyyy dates', () => {
  assert.match(parseDate('15/09/2026'), /^2026-09-15/);
});
