import { addLog, lastAiAttemptAt } from '../db/repositories/checkLogs.repo.js';
import { getBool, getInt, getSetting } from '../db/repositories/settings.repo.js';
import {
  getWebsite,
  listWebsites,
  recordFailure,
  recordSuccess,
  updateWebsite,
} from '../db/repositories/websites.repo.js';
import { notifyNewPosts } from '../notifications/notifier.js';
import { detectNewPosts } from './detector.js';
import { aiConfigured, detectWithAi, fetchWebsiteItems } from './fetchers/index.js';

/**
 * Self-healing detection.
 *
 * A website that suddenly returns nothing has almost always changed its
 * markup. Instead of waiting for someone to notice, the AI reads it once and
 * writes down fresh selectors, which the next checks reuse for free.
 *
 * Deliberately rate-limited: reading every site with the model every minute
 * would cost hundreds of euros a day, while this costs a few calls per site
 * per month and only when something is actually broken.
 */
async function tryAiRecovery(website) {
  if (!aiConfigured()) return null;
  if (!(await getBool('ai_recovery_enabled', true))) return null;
  if (website.detection_method === 'ai') return null;

  const minHours = await getInt('ai_recovery_min_hours', 6);
  const lastAttempt = await lastAiAttemptAt(website.id);
  if (lastAttempt && Date.now() - new Date(lastAttempt).getTime() < minHours * 3600_000) {
    return null;
  }

  const result = await detectWithAi(website);
  if (!result.items.length) return { items: [], usedAi: true, notes: `IA: ${result.notes}` };

  // Keep what it learned, so the next checks need no model at all.
  const selectors = Object.fromEntries(
    Object.entries(result.selectors ?? {}).filter(([, value]) => value),
  );
  if (selectors.list) {
    await updateWebsite(website.id, {
      selector_config: { ...website.selector_config, ...selectors },
      detection_method: website.detection_method === 'auto' ? 'html' : website.detection_method,
    });
  }
  return { items: result.items, usedAi: true, selectors };
}

/** True when the website has never been checked or its interval has elapsed. */
export function isDue(website, now = Date.now()) {
  if (!website.active) return false;
  if (!website.last_checked_at) return true;
  const last = new Date(website.last_checked_at).getTime();
  if (Number.isNaN(last)) return true;
  return now - last >= website.check_interval * 1000;
}

export async function dueWebsites(now = Date.now()) {
  const websites = await listWebsites({ activeOnly: true });
  const due = websites.filter((website) => isDue(website, now));
  // Least recently checked first: when a run is capped (serverless time
  // budget), no website can be starved by the ones before it.
  return due.sort((a, b) => {
    const left = a.last_checked_at ? new Date(a.last_checked_at).getTime() : 0;
    const right = b.last_checked_at ? new Date(b.last_checked_at).getTime() : 0;
    return left - right;
  });
}

/**
 * Full pipeline for a single website: fetch -> detect -> store -> notify -> log.
 * NEVER throws: a failing website must not stop the other 27.
 */
export async function checkWebsite(websiteOrId, { force = false } = {}) {
  const website = typeof websiteOrId === 'object' ? websiteOrId : await getWebsite(websiteOrId);
  if (!website) return { ok: false, error: 'Website not found' };
  if (!website.active && !force) {
    return { ok: false, websiteId: website.id, skipped: 'inactive' };
  }

  const startedAt = Date.now();
  try {
    let fetched = await fetchWebsiteItems(website);

    // Nothing found: let the AI re-learn this site, at most once every few hours.
    let recovery = null;
    let recoveryNote = null;
    if (!fetched.items.length) {
      recovery = await tryAiRecovery(website).catch((error) => {
        recoveryNote = `IA: ${error.message}`;
        console.error(`[crawler] AI recovery failed for "${website.name}": ${error.message}`);
        return null;
      });
      if (recovery?.items.length) {
        fetched = { ...fetched, items: recovery.items, resolvedMethod: 'ai-recovery' };
        recoveryNote = `IA: aprendidos selectores nuevos (${recovery.items.length} publicaciones)`;
      } else if (recovery) {
        fetched = { ...fetched, resolvedMethod: 'ai-recovery' };
        recoveryNote =
          recovery.notes ||
          'IA: esta página no contiene un listado legible (puede cargarse con JavaScript)';
      } else if (!recoveryNote) {
        // No recovery was attempted: say which gate stopped it, so "0 items"
        // is never a dead end for whoever is looking at the dashboard.
        recoveryNote = aiConfigured()
          ? 'Sin publicaciones. La IA no reintenta todavía (espera entre intentos).'
          : 'Sin publicaciones. Configura ANTHROPIC_API_KEY para que la IA lo resuelva sola.';
      }
    }

    const detection = await detectNewPosts(website, fetched.items);

    // In digest mode nothing is emailed on the spot: the findings wait for the
    // daily summary, which is what turns 40 alerts into one useful briefing.
    const mode = await getSetting('notification_mode', 'digest');
    let notification = { sent: false, reason: mode === 'digest' ? 'waiting-for-digest' : 'no-new-posts' };
    if (detection.toNotify.length && mode === 'instant') {
      try {
        notification = await notifyNewPosts(website, detection.toNotify);
      } catch (error) {
        // A mail failure is logged but must not mark the check as failed:
        // the posts stay pending and are retried on the next check.
        notification = { sent: false, reason: 'mail-error', error: error.message };
        console.error(`[crawler] email failed for "${website.name}": ${error.message}`);
      }
    }

    await recordSuccess(website.id, { newestItem: detection.stored[0] ?? null });
    await addLog({
      websiteId: website.id,
      success: true,
      newItems: detection.newCount,
      itemsFound: fetched.items.length,
      method: fetched.resolvedMethod,
      durationMs: Date.now() - startedAt,
      errorMessage:
        notification.reason === 'mail-error' ? `email: ${notification.error}` : recoveryNote,
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
      note: recoveryNote,
      notified: notification.sent,
      notification,
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
export async function runDueChecks({ now = Date.now(), concurrency, limitWebsites = 0 } = {}) {
  let targets = await dueWebsites(now);
  if (!targets.length) return { checked: 0, newItems: 0, failed: 0, results: [] };
  // Serverless runs have a hard time budget: cap the batch when asked to.
  if (limitWebsites > 0) targets = targets.slice(0, limitWebsites);

  const limit = concurrency ?? (await getInt('crawler_concurrency', 8));
  const results = await withConcurrency(targets, limit, (website) => checkWebsite(website));

  return {
    checked: results.length,
    newItems: results.reduce((sum, r) => sum + (r.newItems ?? 0), 0),
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
