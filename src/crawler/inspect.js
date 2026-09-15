import * as cheerio from 'cheerio';
import { fetchText } from './httpClient.js';
import { cleanText } from './normalize.js';
import { discoverFeeds } from './fetchers/html.fetcher.js';

/** Selectors worth counting when figuring out how a listing is built. */
const CANDIDATES = [
  'article', '.post', '.entry', '.news-item', '.noticia', '.noticias', '.card',
  '.item', 'li', 'main a', '.elementor-post', '.wp-block-post', '.blog-post',
  '.views-row', '.node', 'tr',
];

/**
 * Says what a page actually contains, so a listing can be configured without
 * guessing: what came back, whether it needs JavaScript, which feeds it
 * declares, which containers repeat, and what its links look like.
 */
export async function inspectWebsite(website) {
  const { body, finalUrl, contentType } = await fetchText(website.url);
  const $ = cheerio.load(body);

  const scripts = $('script').length;
  $('script, style, noscript').remove();
  const visibleText = cleanText($('body').text());

  const candidates = CANDIDATES.map((selector) => {
    const found = $(selector);
    if (!found.length) return null;
    const sample = cleanText(found.first().text()).slice(0, 120);
    const withLink = found.filter((_, element) => $(element).find('a').length > 0).length;
    return { selector, count: found.length, withLink, sample };
  })
    .filter(Boolean)
    .sort((a, b) => b.withLink - a.withLink || b.count - a.count)
    .slice(0, 8);

  const links = [];
  $('a').each((_, element) => {
    const text = cleanText($(element).text());
    const href = $(element).attr('href');
    if (text.length >= 10 && href && !href.startsWith('#')) {
      links.push({ text: text.slice(0, 120), href });
    }
  });

  return {
    url: finalUrl,
    content_type: contentType,
    bytes: body.length,
    visible_text_length: visibleText.length,
    scripts,
    // A page that is almost all script and almost no text renders client-side:
    // scraping its HTML can never work, whatever selectors you write.
    likely_javascript: visibleText.length < 500 && scripts > 3,
    feeds: discoverFeeds(body, finalUrl),
    candidates,
    links: links.slice(0, 25),
    total_links: links.length,
  };
}
