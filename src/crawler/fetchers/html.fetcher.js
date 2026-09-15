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

/** Links that are navigation, not publications. */
const NOISE = /^(inicio|home|contacto|contact|menu|men\u00fa|login|acceder|buscar|search|ver m\u00e1s|leer m\u00e1s|siguiente|anterior|cookies|aviso legal|privacidad)$/i;

const isNoise = (title, href) =>
  !title ||
  title.length < 12 ||
  NOISE.test(title) ||
  !href ||
  href.startsWith('#') ||
  /^(mailto:|tel:|javascript:)/i.test(href);

/**
 * Last-resort detection for sites whose markup matches none of the usual
 * containers: find the element with the most publication-looking links among
 * its children and treat that as the listing.
 *
 * Real listings share a parent and repeat the same shape, so the container
 * holding the largest group of substantial links is almost always the list of
 * news; menus and footers lose because their texts are short and generic.
 */
function extractByStructure($, baseUrl) {
  const groups = new Map();

  $('a').each((_, element) => {
    const $link = $(element);
    const href = $link.attr('href');
    const title = cleanText($link.attr('title') || $link.text()).slice(0, 300);
    if (isNoise(title, href)) return;

    // Group by grandparent: siblings of a list share it.
    const container = $link.parent().parent().get(0) ?? $link.parent().get(0);
    if (!container) return;
    if (!groups.has(container)) groups.set(container, []);
    groups.get(container).push({ title, href, $link });
  });

  let best = [];
  for (const entries of groups.values()) {
    if (entries.length > best.length) best = entries;
  }
  if (best.length < 2) return [];

  return best.map(({ title, href, $link }) => {
    const $row = $link.closest('li, article, div');
    const date = $row.length ? pickDate($row) : null;
    return toItem({ title, url: href, publishedAt: date, excerpt: null }, baseUrl);
  });
}

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
  if (!nodes || !nodes.length) {
    return selectors.list ? [] : dedupeItems(extractByStructure($, baseUrl).filter(Boolean)).slice(0, 100);
  }

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

  const found = dedupeItems(items).slice(0, 100);
  // The container matched but yielded nothing usable (a wrapper <article>, a
  // card grid with no links...): fall back to the structural scan.
  if (!found.length && !selectors.list) {
    return dedupeItems(extractByStructure($, baseUrl).filter(Boolean)).slice(0, 100);
  }
  return found;
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
