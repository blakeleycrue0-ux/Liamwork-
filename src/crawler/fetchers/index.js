import { fetchText } from '../httpClient.js';
import { fetchViaRss } from './rss.fetcher.js';
import { discoverFeeds, extractFromHtml, fetchViaHtml } from './html.fetcher.js';
import { fetchViaBrowser } from './browser.fetcher.js';

export const DETECTION_METHODS = ['auto', 'rss', 'html', 'browser'];

/** Common feed locations, tried only when the page declares none. */
const COMMON_FEED_PATHS = ['/feed', '/rss', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml', '/?feed=rss2'];

/**
 * "auto": prefer RSS (declared, configured or guessed), fall back to HTML.
 * Keeps per-website configuration optional while still allowing full control.
 */
async function fetchAuto(website) {
  const configured = website.selector_config?.feed_url;
  if (configured) {
    return { ...(await fetchViaRss(website, { feedUrl: configured })), resolvedMethod: 'rss' };
  }

  let page = null;
  try {
    page = await fetchViaHtml(website);
  } catch (error) {
    // The URL itself may already be a feed.
    const feed = await fetchViaRss(website).catch(() => null);
    if (feed) return { ...feed, resolvedMethod: 'rss' };
    throw error;
  }

  if (/xml|rss|atom/i.test(page.source) || /^\s*<(\?xml|rss|feed)/i.test(page.html.slice(0, 200))) {
    const feed = await fetchViaRss(website, { feedUrl: page.finalUrl }).catch(() => null);
    if (feed) return { ...feed, resolvedMethod: 'rss' };
  }

  const candidates = [
    ...discoverFeeds(page.html, page.finalUrl),
    ...COMMON_FEED_PATHS.map((p) => {
      try {
        return new URL(p, page.finalUrl).toString();
      } catch {
        return null;
      }
    }).filter(Boolean),
  ];

  for (const feedUrl of candidates) {
    const feed = await fetchViaRss(website, { feedUrl }).catch(() => null);
    if (feed?.items.length) return { ...feed, resolvedMethod: 'rss', discoveredFeed: feedUrl };
  }

  return { ...page, resolvedMethod: 'html' };
}

/** Dispatches to the fetcher configured for a website. */
export async function fetchWebsiteItems(website) {
  switch (website.detection_method) {
    case 'rss':
      return { ...(await fetchViaRss(website)), resolvedMethod: 'rss' };
    case 'html':
      return { ...(await fetchViaHtml(website)), resolvedMethod: 'html' };
    case 'browser':
      return { ...(await fetchViaBrowser(website)), resolvedMethod: 'browser' };
    case 'auto':
    default:
      return fetchAuto(website);
  }
}

/** Used by the dashboard "test configuration" action. */
export async function previewWebsite(website) {
  const result = await fetchWebsiteItems(website);
  return {
    method: result.resolvedMethod,
    source: result.discoveredFeed || result.source,
    items: result.items.slice(0, 10),
    total: result.items.length,
  };
}

export { fetchText, extractFromHtml, discoverFeeds };
