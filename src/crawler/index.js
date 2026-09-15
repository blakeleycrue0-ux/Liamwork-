import { addLog } from '../db/repositories/checkLogs.repo.js';
import { getInt } from '../db/repositories/settings.repo.js';
import {
  getWebsite,
  listWebsites,
  recordFailure,
  recordSuccess,
} from '../db/repositories/websites.repo.js';
import { notifyNewPosts } from '../notifications/notifier.js';
import { detectNewPosts } from './detector.js';
import { fetchWebsiteItems } from './fetchers/index.js';

/** True when the website has never been checked or its interval has elapsed. */
export function isDue(website, now = Date.now()) {
  if (!website.active) return false;
  if (!website.last_checked_at) return true;
  const last = new Date(website.last_checked_at).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= website.check_interval * 1000;
}

export function dueWebsites(now = Date.now()) {
  return listWebsites({ activeOnly: true }).filter((website) => isDue(website, now));
}

/**
 * Full pipeline for a single website: fetch -> detect -> store -> notify -> log.
 * NEVER throws: a failing website must not stop the other 27.
 */
export async function checkWebsite(websiteOrId, { force = false } = {}) {
  const website = typeof websiteOrId === 'object' ? websiteOrId : getWebsite(websiteOrId);
  if (!website) return { ok: false, error: 'Website not found' };
  if (!website.active && !force) {
    return { ok: false, websiteId: website.id, skipped: 'inactive' };
  }

  const startedAt = Date.now();
  try {
    const fetched = await fetchWebsiteItems(website);
    const detection = detectNewPosts(website, fetched.items);

    let notification = { sent: false, reason: 'no-new-posts' };
    if (detection.toNotify.length) {
      try {
        notification = await notifyNewPosts(website, detection.toNotify);
      } catch (error) {
        // A mail failure is logged but must not mark the check as failed:
        // the posts stay pending and are retried on the next check.
        notification = { sent: false, reason: 'mail-error', error: error.message };
        console.error(`[crawler] email failed for "${website.name}": ${error.message}`);
      }
    }

    recordSuccess(website.id, { newestItem: detection.stored[0] ?? null });
    addLog({
      websiteId: website.id,
      success: true,
      newItems: detection.newCount,
      itemsFound: fetched.items.length,
      method: fetched.resolvedMethod,
      durationMs: Date.now() - startedAt,
      errorMessage: notification.reason === 'mail-error' ? `email: ${notification.error}` : null,
    });

    return {
      ok: true,
      websiteId: website.id,
      name: website.name,
      method: fetched.resolvedMethod,
      source: fetched.discoveredFeed || fetched.source,
      itemsFound: fetched.items.length,
      newItems: detection.newCount,
      baseline: detection.baseline,
      notified: notification.sent,
      notification,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    recordFailure(website.id, error.message);
    addLog({
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
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Runs tasks with a bounded number of parallel workers. */
async function withConcurrency(items, limit, handler) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await handler(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One crawler pass over every website that is due. */
export async function runDueChecks({ now = Date.now(), concurrency } = {}) {
  const targets = dueWebsites(now);
  if (!targets.length) return { checked: 0, results: [] };

  const limit = concurrency ?? getInt('crawler_concurrency', 8);
  const results = await withConcurrency(targets, limit, (website) => checkWebsite(website));

  return {
    checked: results.length,
    newItems: results.reduce((sum, r) => sum + (r.newItems ?? 0), 0),
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
