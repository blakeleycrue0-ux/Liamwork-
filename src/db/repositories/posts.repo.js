import { getDb, nowIso } from '../index.js';

/**
 * Inserts the items that are not known yet for this website.
 * De-duplication is enforced by the UNIQUE(website_id, content_hash) index,
 * so a re-run of the same check can never create a duplicate alert.
 * @returns {Array} the rows that were actually new
 */
export function insertNewItems(websiteId, items) {
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO posts (website_id, title, url, published_at, content_hash, excerpt, first_seen_at)
     VALUES (@website_id, @title, @url, @published_at, @content_hash, @excerpt, @first_seen_at)`,
  );
  const selectByHash = db.prepare(
    'SELECT * FROM posts WHERE website_id = ? AND content_hash = ?',
  );

  const insertedIds = [];
  const tx = db.transaction((list) => {
    for (const item of list) {
      const info = insert.run({
        website_id: websiteId,
        title: item.title,
        url: item.url ?? null,
        published_at: item.publishedAt ?? null,
        content_hash: item.contentHash,
        excerpt: item.excerpt ?? null,
        first_seen_at: nowIso(),
      });
      if (info.changes > 0) insertedIds.push(item.contentHash);
    }
  });
  tx(items);

  return insertedIds.map((hash) => selectByHash.get(websiteId, hash));
}

export function markNotified(ids, at = nowIso()) {
  if (!ids.length) return 0;
  const db = getDb();
  const stmt = db.prepare('UPDATE posts SET notified_at = ? WHERE id = ? AND notified_at IS NULL');
  const tx = db.transaction((list) => list.reduce((n, id) => n + stmt.run(at, id).changes, 0));
  return tx(ids);
}

export function pendingNotification(websiteId) {
  return getDb()
    .prepare('SELECT * FROM posts WHERE website_id = ? AND notified_at IS NULL ORDER BY first_seen_at')
    .all(websiteId);
}

export function listPosts({ websiteId = null, limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const sql = `SELECT p.*, w.name AS website_name, w.url AS website_url
               FROM posts p JOIN websites w ON w.id = p.website_id
               ${websiteId ? 'WHERE p.website_id = @websiteId' : ''}
               ORDER BY p.first_seen_at DESC, p.id DESC
               LIMIT @limit OFFSET @offset`;
  return db.prepare(sql).all({ websiteId, limit, offset });
}

export function countRecent(sinceIso) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM posts WHERE first_seen_at >= ?')
    .get(sinceIso).n;
}

export function countPostsByWebsite(websiteId) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM posts WHERE website_id = ?').get(websiteId).n;
}
