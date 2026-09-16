import crypto from 'node:crypto';
import * as cheerio from 'cheerio';
import { decodeLine, decodeText } from '../crawler/encoding.js';

/**
 * Turns a page into the text we store, hash and eventually show Claude.
 *
 * The whole point is that the text must be STABLE: two fetches of a page
 * nobody edited have to produce byte-identical output, or every rotating
 * banner and every "generated at" footer would look like news. So everything
 * that is furniture rather than content is removed before we look at a word
 * of it, and the hash is taken over what is left.
 */

/** Structural furniture: present on every page, never the reason for an alert. */
const CHROME = [
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'canvas',
  'template',
  'link',
  'meta',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'button',
  'select',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="search"]',
  '[aria-hidden="true"]',
  '[hidden]',
];

/**
 * Class and id fragments that mark a block as chrome. Deliberately specific:
 * a rule broad enough to catch "content-nav" would also delete the article.
 */
const CHROME_PATTERN =
  /(^|[-_ ])(cookie|cookies|consent|gdpr|rgpd|navbar|nav-menu|menu|megamenu|breadcrumb|sidebar|widget|banner|advert|ads?|adsense|sponsor|social|share|sharing|newsletter|subscribe|popup|modal|overlay|offcanvas|skip-link|back-to-top|pagination|pager|search-form|login|cart|basket|language-switcher|lang-switch|copyright|site-footer|site-header)([-_ ]|$)/i;

/** Where the real content lives, in the order we prefer to find it. */
const MAIN_CANDIDATES = [
  'main',
  '[role="main"]',
  'article',
  '#content',
  '#main',
  '.content',
  '.main-content',
  '.entry-content',
  '.post-content',
  '.page-content',
];

/**
 * Values that legitimately change on every single request. Left in, they
 * would make every page look edited twice a day, forever.
 */
const VOLATILE = [
  // Cache busters and session ids inside inline text
  /\b(?:sid|sessionid|session_id|csrf[-_]?token|nonce|_t|cb|v)=[A-Za-z0-9_-]{6,}/gi,
  // "Senast uppdaterad 16/09/2026 18:44" style stamps, time part only
  /\b\d{1,2}:\d{2}(?::\d{2})?\b/g,
  // Visitor counters
  /\b\d{1,3}(?:[ .,]\d{3})*\s*(?:bes[öo]kare|visitors|visitas|views|visningar)\b/gi,
];

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Removes everything that is page furniture rather than page content. */
export function stripChrome($) {
  $(CHROME.join(',')).remove();
  $('*').each((_, element) => {
    const attribs = element.attribs ?? {};
    const marker = `${attribs.class ?? ''} ${attribs.id ?? ''}`.trim();
    if (marker && CHROME_PATTERN.test(marker)) $(element).remove();
  });
  $('*')
    .contents()
    .filter((_, node) => node.type === 'comment')
    .remove();
  return $;
}

/**
 * The visible text of a page, as close to what a reader sees as we can get
 * without a browser: block elements become line breaks, inline ones do not.
 */
export function visibleText($, root) {
  const scope = root ?? $.root();
  scope.find('br').replaceWith('\n');
  scope.find('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, blockquote, dd, dt').append('\n');
  return decodeText(scope.text());
}

/** Strips the handful of values that legitimately differ on every fetch. */
export function removeVolatile(text) {
  let result = text;
  for (const pattern of VOLATILE) result = result.replace(pattern, ' ');
  return result.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
}

/**
 * Full extraction for one page.
 *
 * @returns title, text (normalised, UTF-8 clean), textHash, and the dates the
 *   page declares about itself - which is how a 2025 article stays a 2025
 *   article no matter when the crawler first happens to see it.
 */
export function extractPage(html, url) {
  const $ = cheerio.load(html);

  const title =
    decodeLine($('meta[property="og:title"]').attr('content')) ||
    decodeLine($('h1').first().text()) ||
    decodeLine($('title').first().text()) ||
    decodeLine(url);

  const description =
    decodeLine($('meta[property="og:description"]').attr('content')) ||
    decodeLine($('meta[name="description"]').attr('content')) ||
    '';

  const publishedAt = firstDate([
    $('meta[property="article:published_time"]').attr('content'),
    $('meta[name="date"]').attr('content'),
    $('meta[itemprop="datePublished"]').attr('content'),
    $('time[datetime]').first().attr('datetime'),
    $('time').first().text(),
  ]);

  const modifiedAt = firstDate([
    $('meta[property="article:modified_time"]').attr('content'),
    $('meta[itemprop="dateModified"]').attr('content'),
  ]);

  stripChrome($);

  let root = null;
  for (const selector of MAIN_CANDIDATES) {
    const candidate = $(selector).first();
    if (candidate.length && candidate.text().trim().length > 200) {
      root = candidate;
      break;
    }
  }

  const text = removeVolatile(visibleText($, root ?? $('body')));

  return {
    title,
    description,
    publishedAt,
    modifiedAt,
    text,
    charCount: text.length,
    textHash: sha256(text),
  };
}

/** ISO-8601, or null. Never guesses: a wrong date is worse than no date. */
export function firstDate(values) {
  for (const value of values) {
    const parsed = parseDateStrict(value);
    if (parsed) return parsed;
  }
  return null;
}

export function parseDateStrict(value) {
  if (!value) return null;
  const raw = decodeLine(value);
  if (!raw) return null;

  // ISO first: it is unambiguous and it is what metadata uses.
  const iso = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/.exec(raw);
  if (iso) {
    const date = new Date(iso[0]);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  // dd/mm/yyyy and dd-mm-yyyy, the European order these sites write in.
  const european = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(raw);
  if (european) {
    const [, day, month, year] = european;
    if (Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31) {
      const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

export { sha256 };
