import { addLog } from '../db/repositories/checkLogs.repo.js';
import { getInt } from '../db/repositories/settings.repo.js';
import {
  markBaselineDone,
  markMissing,
  recordCapture,
  recordPageError,
  upsertPage,
} from '../db/repositories/pages.repo.js';
import { getWebsite, listWebsites, recordFailure, recordSuccess } from '../db/repositories/websites.repo.js';
import { fetchWebsiteItems } from '../crawler/fetchers/index.js';
import { fetchText } from '../crawler/httpClient.js';
import { canonicalUrl } from '../crawler/normalize.js';
import { decodeLine } from '../crawler/encoding.js';
import { extractPage } from './extract.js';

/**
 * Stage one of the pipeline: fetch, store, and work out what MIGHT have
 * changed. Nothing here decides whether a change matters - that is Claude's
 * job in stage two, and keeping the two apart is what stops the model being
 * asked about 27 websites that did nothing.
 *
 * For each website:
 *   1. read the listing (RSS if there is one, HTML otherwise) to find pages
 *   2. fetch each page and reduce it to normalised text
 *   3. store a new version ONLY when that text differs from the last one
 *
 * A page whose text is identical produces no version, no candidate and no
 * tokens. That is the whole cost strategy in one sentence.
 */

/**
 * Only a page with essentially no text is skipped.
 *
 * The threshold is deliberately near zero. A listing page can be a handful of
 * words plus a column of links, and that column is exactly the signal we are
 * here for - a stricter rule would discard the one page per site that tells
 * us an article appeared. What this does catch is a page that rendered to
 * nothing, which would otherwise flap in and out of "changed" forever.
 */
const MIN_TEXT_CHARS = 10;

/** Runs tasks with a bounded number of parallel workers. */
async function withConcurrency(items, limit, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await handler(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The URLs worth looking at for one website: the listing page itself, plus
 * the most recent entries it links to.
 *
 * Capped rather than exhaustive. Crawling a whole site twice a day would be
 * rude to the site and pointless for us: news appears at the top of a listing,
 * and a page nobody links to any more is not what the report is about.
 */
export async function discoverPages(website, { maxPages }) {
  const listing = await fetchWebsiteItems(website);

  const targets = [
    { url: canonicalUrl(website.url), title: website.name, source: 'listing' },
  ];

  for (const item of listing.items) {
    if (targets.length > maxPages) break;
    const url = canonicalUrl(item.url);
    if (!url || targets.some((target) => target.url === url)) continue;
    targets.push({ url, title: item.title, source: listing.resolvedMethod });
  }

  return { targets, listing };
}

/**
 * Fetches one page and stores a version if its content moved.
 * NEVER throws: one dead page must not cost us the other twelve.
 *
 * `isBaselineRun` is the first crawl of a WEBSITE, not of a page. The
 * difference matters: on a site's first crawl everything is unknown and
 * nothing is news, but once a site is established, a URL we have never
 * fetched is a real candidate - it may be today's article, or it may be a
 * 2019 page that just scrolled into view, and only the analyser can tell
 * those apart.
 */
export async function capturePage(website, target, { at, isBaselineRun = false }) {
  const { page } = await upsertPage({
    websiteId: website.id,
    url: target.url,
    title: target.title,
    source: target.source,
    at,
  });
  if (!page) return { ok: false, url: target.url, error: 'no se pudo registrar la página' };

  // Read before this capture overwrites it: the last time we looked at this
  // page and it was still the same. Whatever changed, changed after that.
  const lastLookedAt = page.last_checked_at ?? null;

  try {
    const { body, finalUrl } = await fetchText(target.url);
    const capture = extractPage(body, finalUrl);

    if (capture.charCount < MIN_TEXT_CHARS) {
      await recordPageError(page.id, `Contenido demasiado corto (${capture.charCount} caracteres)`, { at });
      return { ok: true, pageId: page.id, url: target.url, changed: false, skipped: 'sin-contenido' };
    }

    const outcome = await recordCapture(page, { ...capture, source: target.source }, { at });

    // The website's very first crawl only establishes what its pages say
    // today. It is not a day's news, and reporting it would mean 28 emails
    // containing every archive page the sites happen to link to.
    if (isBaselineRun) {
      await markBaselineDone(page.id);
      return { ok: true, pageId: page.id, url: target.url, changed: false, baseline: true };
    }

    return {
      ok: true,
      pageId: page.id,
      url: target.url,
      title: decodeLine(capture.title),
      changed: outcome.changed,
      firstCapture: outcome.baseline,
      versionId: outcome.version?.id ?? null,
      previousVersionId: outcome.previous?.id ?? null,
      // When the page was last observed unchanged. The edit happened between
      // then and now, and that interval is what dates it - not the clock at
      // the moment the crawler happened to run. Using the last LOOK rather
      // than the last stored version matters: a page checked four times since
      // its last edit narrows the window to hours instead of days.
      previousCapturedAt: lastLookedAt ?? outcome.previous?.captured_at ?? null,
      charCount: capture.charCount,
    };
  } catch (error) {
    await recordPageError(page.id, error.message, { at });
    return { ok: false, pageId: page.id, url: target.url, error: error.message };
  }
}

/**
 * One full pass over a single website.
 * NEVER throws: a failing website must not stop the other 27.
 */
export async function crawlWebsite(websiteOrId, { maxPages = 12, concurrency = 4, at } = {}) {
  const website = typeof websiteOrId === 'object' ? websiteOrId : await getWebsite(websiteOrId);
  if (!website) return { ok: false, error: 'Website not found' };

  const startedAt = Date.now();
  const timestamp = at ?? new Date().toISOString();

  const isBaselineRun = !website.baseline_done;
  // Read before the crawl overwrites it: for a page we have never captured,
  // this is the last moment we know the website looked different.
  const previouslyCheckedAt = website.last_checked_at ?? null;

  try {
    const { targets, listing } = await discoverPages(website, { maxPages });
    const results = await withConcurrency(targets, concurrency, (target) =>
      capturePage(website, target, { at: timestamp, isBaselineRun }),
    );

    const changed = results.filter((result) => result.ok && result.changed);
    const failed = results.filter((result) => !result.ok);
    const missing = await markMissing(
      website.id,
      results.filter((result) => result.ok).map((result) => result.url),
      { at: timestamp },
    );

    await recordSuccess(website.id, { newestItem: null });
    await addLog({
      websiteId: website.id,
      success: true,
      newItems: changed.length,
      itemsFound: targets.length,
      method: listing.resolvedMethod,
      durationMs: Date.now() - startedAt,
      errorMessage: failed.length ? `${failed.length} página(s) con error` : null,
    });

    return {
      ok: true,
      websiteId: website.id,
      name: website.name,
      method: listing.resolvedMethod,
      pagesSeen: targets.length,
      pagesChanged: changed.length,
      pagesFailed: failed.length,
      pagesMissing: missing.length,
      baseline: isBaselineRun,
      candidates: changed.map((result) => ({
        pageId: result.pageId,
        versionId: result.versionId,
        previousVersionId: result.previousVersionId,
        url: result.url,
        title: result.title,
        firstCapture: Boolean(result.firstCapture),
        observedSince: result.previousCapturedAt ?? previouslyCheckedAt,
      })),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    await recordFailure(website.id, error.message);
    await addLog({
      websiteId: website.id,
      success: false,
      method: website.detection_method,
      durationMs: Date.now() - startedAt,
      errorMessage: error.message,
    });
    return {
      ok: false,
      websiteId: website.id,
      name: website.name,
      error: error.message,
      candidates: [],
      durationMs: Date.now() - startedAt,
    };
  }
}

/** One pass over every active website. */
export async function crawlAll({ maxPages, concurrency, limitWebsites = 0, at } = {}) {
  const websites = await listWebsites({ activeOnly: true });
  const targets = limitWebsites > 0 ? websites.slice(0, limitWebsites) : websites;
  if (!targets.length) return { websites: 0, changed: 0, failed: 0, candidates: [], results: [] };

  const pages = maxPages ?? (await getInt('max_pages_per_website', 12));
  const workers = concurrency ?? (await getInt('crawler_concurrency', 6));
  const timestamp = at ?? new Date().toISOString();

  const results = await withConcurrency(targets, workers, (website) =>
    crawlWebsite(website, { maxPages: pages, concurrency: 3, at: timestamp }),
  );

  return {
    websites: results.length,
    changed: results.reduce((sum, result) => sum + (result.pagesChanged ?? 0), 0),
    failed: results.filter((result) => !result.ok).length,
    candidates: results.flatMap((result) =>
      (result.candidates ?? []).map((candidate) => ({
        ...candidate,
        websiteId: result.websiteId,
        websiteName: result.name,
      })),
    ),
    results,
  };
}
