import { getDb, num, nowIso } from '../index.js';

/**
 * Pages and their versions.
 *
 * The rule the whole system rests on lives here: seeing a URL again is not a
 * change. A page only gets a new version row when the text it carries is
 * different from the text we last stored, and nothing downstream ever looks
 * at "when did the crawler first fetch this" to decide whether it is news.
 */

/** Records that a page exists and was seen now. Never touches its content. */
export async function upsertPage({ websiteId, url, title, source, at = nowIso() }) {
  const db = await getDb();
  const existing = await db.get('SELECT * FROM pages WHERE website_id = ? AND url = ?', [
    websiteId,
    url,
  ]);

  if (existing) {
    await db.run('UPDATE pages SET last_seen_at = ?, status = ?, title = COALESCE(?, title) WHERE id = ?', [
      at,
      'active',
      title ?? null,
      existing.id,
    ]);
    return { page: { ...existing, last_seen_at: at }, created: false };
  }

  const page = await db.get(
    `INSERT INTO pages (website_id, url, title, status, discovered_at, last_seen_at, source)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT (website_id, url) DO NOTHING
     RETURNING *`,
    [websiteId, url, title ?? null, at, at, source ?? null],
  );

  // Lost a race with a concurrent worker: the row exists, which is all we want.
  if (!page) {
    const row = await db.get('SELECT * FROM pages WHERE website_id = ? AND url = ?', [websiteId, url]);
    return { page: row, created: false };
  }
  return { page, created: true };
}

/** The most recent stored version of a page, or null on a first capture. */
export async function latestVersion(pageId) {
  const db = await getDb();
  return (
    (await db.get(
      'SELECT * FROM page_versions WHERE page_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1',
      [pageId],
    )) ?? null
  );
}

/**
 * Stores a capture, but only when the text actually differs from the last one.
 *
 * @returns {Promise<{changed: boolean, version: object|null, previous: object|null, baseline: boolean}>}
 */
export async function recordCapture(page, capture, { at = nowIso() } = {}) {
  const db = await getDb();
  const previous = await latestVersion(page.id);

  await db.run(
    `UPDATE pages SET last_checked_at = ?, last_seen_at = ?, consecutive_errors = 0, last_error = NULL,
       title = COALESCE(?, title), published_at = COALESCE(published_at, ?), modified_at = ?
     WHERE id = ?`,
    [at, at, capture.title ?? null, capture.publishedAt ?? null, capture.modifiedAt ?? null, page.id],
  );

  if (previous && previous.text_hash === capture.textHash) {
    return { changed: false, version: null, previous, baseline: false };
  }

  const version = await db.get(
    `INSERT INTO page_versions (page_id, captured_at, text_hash, title, text, char_count, published_at, modified_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [
      page.id,
      at,
      capture.textHash,
      capture.title ?? null,
      capture.text,
      capture.charCount ?? capture.text.length,
      capture.publishedAt ?? null,
      capture.modifiedAt ?? null,
      capture.source ?? null,
    ],
  );

  await db.run(
    `UPDATE pages SET text_hash = ?, char_count = ?, version_count = version_count + 1,
       last_changed_at = ?, first_content_at = COALESCE(first_content_at, ?)
     WHERE id = ?`,
    [capture.textHash, version.char_count, at, at, page.id],
  );

  return { changed: true, version, previous, baseline: !previous };
}

export async function recordPageError(pageId, message, { at = nowIso() } = {}) {
  const db = await getDb();
  await db.run(
    `UPDATE pages SET last_checked_at = ?, consecutive_errors = consecutive_errors + 1, last_error = ?
     WHERE id = ?`,
    [at, String(message).slice(0, 500), pageId],
  );
}

/**
 * Marks pages a crawl no longer finds. Not deleted: a page that disappears is
 * itself worth knowing about, and its history stays readable.
 */
export async function markMissing(websiteId, seenUrls, { at = nowIso() } = {}) {
  const db = await getDb();
  const rows = await db.all("SELECT id, url FROM pages WHERE website_id = ? AND status = 'active'", [
    websiteId,
  ]);
  const seen = new Set(seenUrls);
  const missing = rows.filter((row) => !seen.has(row.url));
  for (const row of missing) {
    await db.run("UPDATE pages SET status = 'missing', last_checked_at = ? WHERE id = ?", [at, row.id]);
  }
  return missing;
}

/** Marks a page's baseline capture as closed, so it is never reported. */
export async function markBaselineDone(pageId) {
  const db = await getDb();
  await db.run('UPDATE pages SET baseline_done = 1 WHERE id = ?', [pageId]);
}

export async function listPages({ websiteId = null, limit = 100, offset = 0 } = {}) {
  const db = await getDb();
  const where = websiteId ? 'WHERE p.website_id = ?' : '';
  const params = websiteId ? [websiteId, limit, offset] : [limit, offset];
  return db.all(
    `SELECT p.*, w.name AS website_name
     FROM pages p JOIN websites w ON w.id = p.website_id
     ${where}
     ORDER BY p.last_changed_at DESC NULLS LAST, p.id DESC
     LIMIT ? OFFSET ?`,
    params,
  );
}

export async function listVersions(pageId, limit = 20) {
  const db = await getDb();
  return db.all(
    `SELECT id, page_id, captured_at, text_hash, title, char_count, published_at, modified_at
     FROM page_versions WHERE page_id = ? ORDER BY captured_at DESC, id DESC LIMIT ?`,
    [pageId, limit],
  );
}

export async function getVersion(id) {
  const db = await getDb();
  return db.get('SELECT * FROM page_versions WHERE id = ?', [id]);
}

export async function countPages(websiteId) {
  const db = await getDb();
  const row = await db.get("SELECT COUNT(*) AS n FROM pages WHERE website_id = ? AND status = 'active'", [
    websiteId,
  ]);
  return num(row?.n);
}
