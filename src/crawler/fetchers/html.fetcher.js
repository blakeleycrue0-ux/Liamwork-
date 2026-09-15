import * as cheerio from 'cheerio';
import { fetchText } from '../httpClient.js';
import { cleanText, dedupeItems, toItem } from '../normalize.js';

/** Selectors tried when a website has no explicit configuration yet. */
const FALLBACK_LIST_SELECTORS = [
  'article',
  '.post',
  '.entry',
  '.news-item',
  '.noticia',
  '.card',
  'li.item',
  '[class*="post-"]',
  'main li',
];
const TITLE_SELECTORS = 'h1 a, h2 a, h3 a, h1, h2, h3, .title, .entry-title, a';
const DATE_SELECTORS = 'time, .date, .fecha, .published, [datetime]';

const pickDate = ($el) => {
  const node = $el.find(DATE_SELECTORS).first();
  if (!node.length) return null;
  return node.attr('datetime') || cleanText(node.text());
};

/**
 * Extracts publications from an HTML document.
 * `selectors` may define: list, title, link, date. Anything missing falls back
 * to a generic heuristic, so a new website works before it is fine-tuned.
 */
export function extractFromHtml(html, baseUrl, selectors = {}) {
  const $ = cheerio.load(html);

  const candidates = selectors.list
    ? [selectors.list]
    : FALLBACK_LIST_SELECTORS;

  let nodes = null;
  for (const selector of candidates) {
    const found = $(selector);
    if (found.length) {
      nodes = found;
      break;
    }
  }
  if (!nodes || !nodes.length) return [];

  const items = nodes
    .toArray()
    .map((element) => {
      const $el = $(element);
      const titleNode = selectors.title ? $el.find(selectors.title).first() : $el.find(TITLE_SELECTORS).first();
      const linkNode = selectors.link ? $el.find(selectors.link).first() : ($el.is('a') ? $el : $el.find('a').first());
      const title = cleanText(titleNode.length ? titleNode.text() : $el.text()).slice(0, 300);
      const href = linkNode.attr('href') || (selectors.link ? null : titleNode.attr('href'));
      const date = selectors.date ? cleanText($el.find(selectors.date).first().text()) : pickDate($el);
      if (!title && !href) return null;
      return toItem({ title, url: href, publishedAt: date, excerpt: null }, baseUrl);
    })
    .filter(Boolean)
    // Ignore navigation noise: entries without a link and with a very short title.
    .filter((item) => item.url || item.title.length > 12);

  return dedupeItems(items).slice(0, 100);
}

/** Looks for a feed declared in <link rel="alternate">, plus common paths. */
export function discoverFeeds(html, baseUrl) {
  const $ = cheerio.load(html);
  const found = [];
  $('link[rel="alternate"]').each((_, element) => {
    const type = ($(element).attr('type') || '').toLowerCase();
    const href = $(element).attr('href');
    if (href && /(rss|atom|xml)/.test(type)) {
      try {
        found.push(new URL(href, baseUrl).toString());
      } catch {
        /* ignore malformed href */
      }
    }
  });
  return [...new Set(found)];
}

export async function fetchViaHtml(website, { url } = {}) {
  const target = url || website.url;
  const { body, finalUrl } = await fetchText(target);
  const items = extractFromHtml(body, finalUrl, website.selector_config || {});
  return { items, method: 'html', source: target, html: body, finalUrl };
}
