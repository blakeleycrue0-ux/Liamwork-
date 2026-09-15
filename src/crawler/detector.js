import { insertNewItems, markNotified } from '../db/repositories/posts.repo.js';
import { getBool } from '../db/repositories/settings.repo.js';

/**
 * Turns a list of fetched items into "new publications".
 *
 * Detection is content-based, not visual: an item counts as new only when its
 * content_hash (guid > canonical URL > title) has never been stored for this
 * website. A restyled page or a changed banner therefore produces no alert.
 *
 * The very first successful check of a website only builds the baseline
 * (it stores everything without notifying), unless `notify_on_first_check`
 * is enabled in Settings.
 */
export async function detectNewPosts(website, items) {
  const isBaselineRun = !website.baseline_done;
  const stored = await insertNewItems(website.id, items);

  const notifyOnFirst = await getBool('notify_on_first_check', false);
  const shouldNotify = stored.length > 0 && (!isBaselineRun || notifyOnFirst);

  // Baseline items are closed straight away so they can never be picked up as
  // a pending backlog by a later check.
  if (stored.length && !shouldNotify) await markNotified(stored.map((post) => post.id));

  return {
    stored,
    newCount: stored.length,
    baseline: isBaselineRun,
    toNotify: shouldNotify ? stored : [],
  };
}
