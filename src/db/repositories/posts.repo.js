import { getDb, num, nowIso } from '../index.js';

/**
 * Inserts the items that are not known yet for this website.
 * De-duplication is enforced by the UNIQUE(website_id, content_hash) index, so
 * a re-run of the same check can never create a duplicate alert.
 * @returns {Promise<Array>} the rows that were actually new
 */
export async function insertNewItems(websiteId, items) {
  if (!items.length) return [];
  const db = await getDb();

  return db.transaction(async (tx) => {
    const inserted = [];
    for (const item of items) {
      const row = await tx.get(
        `INSERT INTO posts (website_id, title, url, published_at, content_hash, excerpt, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (website_id, content_hash) DO NOTHING
         RETURNING *`,
        [
          websiteId,
          item.title,
          item.url ?? null,
          item.publishedAt ?? null,
          item.contentHash,
          item.excerpt ?? null,
          nowIso(),
        ],
      );
      if (row) inserted.push(row);
    }
    return inserted;
  });
}

export async function markNotified(ids, at = nowIso()) {
  if (!ids.length) return 0;
  const db = await getDb();
  return db.transaction(async (tx) => {
    let changed = 0;
    for (const id of ids) {
      const { changes } = await tx.run(
        'UPDATE posts SET notified_at = ? WHERE id = ? AND notified_at IS NULL',
        [at, id],
      );
      changed += changes;
    }
    return changed;
  });
}

export async function pendingNotification(websiteId) {
  const db = await getDb();
  return db.all(
    'SELECT * FROM posts WHERE website_id = ? AND notified_at IS NULL ORDER BY first_seen_at',
    [websiteId],
  );
}

/** Everything detected and not yet reported, across every website. */
export async function pendingForDigest(limit = 200) {
  const db = await getDb();
  return db.all(
    `SELECT p.*, w.name AS website_name, w.url AS website_url
     FROM posts p JOIN websites w ON w.id = p.website_id
     WHERE p.notified_at IS NULL
     ORDER BY w.name, p.first_seen_at
     LIMIT ?`,
    [limit],
  );
}

export async function listPosts({ websiteId = null, limit = 50, offset = 0 } = {}) {
  const db = await getDb();
  const where = websiteId ? 'WHERE p.website_id = ?' : '';
  const params = websiteId ? [websiteId, limit, offset] : [limit, offset];
  return db.all(
    `SELECT p.*, w.name AS website_name, w.url AS website_url
     FROM posts p JOIN websites w ON w.id = p.website_id
     ${where}
     ORDER BY p.first_seen_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    params,
  );
}

export async function countRecent(sinceIso) {
  const db = await getDb();
  const row = await db.get('SELECT COUNT(*) AS n FROM posts WHERE first_seen_at >= ?', [sinceIso]);
  return num(row?.n);
}

export async function countPostsByWebsite(websiteId) {
  const db = await getDb();
  const row = await db.get('SELECT COUNT(*) AS n FROM posts WHERE website_id = ?', [websiteId]);
  return num(row?.n);
}
