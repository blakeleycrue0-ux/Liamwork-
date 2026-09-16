import { getDb, num, nowIso } from '../index.js';

/**
 * Claude's verdicts, with the audit trail.
 *
 * Every row records not just what was decided but what was shown to the model
 * and what came back, so "why did the system think this changed?" is a query
 * rather than a guess.
 */

export const CHANGE_TYPES = ['NEW', 'UPDATED', 'UNCHANGED', 'IGNORED'];
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];

/** Reportable means: a person should see it. The other two are bookkeeping. */
export const REPORTABLE = ['NEW', 'UPDATED'];

export async function recordChange(change, { at = nowIso() } = {}) {
  const db = await getDb();
  return db.get(
    `INSERT INTO detected_changes (
       page_id, website_id, from_version_id, to_version_id, detected_at, change_date,
       change_type, priority, title, url, summary, what_changed, previous_value, new_value,
       reasoning, analyzer, model, input_tokens, output_tokens, cached_tokens,
       analysis_input, analysis_output
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (to_version_id, page_id) DO NOTHING
     RETURNING *`,
    [
      change.pageId ?? null,
      change.websiteId,
      change.fromVersionId ?? null,
      change.toVersionId ?? null,
      at,
      change.changeDate,
      change.changeType,
      change.priority ?? 'LOW',
      change.title ?? null,
      change.url ?? null,
      change.summary ?? null,
      change.whatChanged ?? null,
      change.previousValue ?? null,
      change.newValue ?? null,
      change.reasoning ?? null,
      change.analyzer ?? 'claude',
      change.model ?? null,
      change.inputTokens ?? 0,
      change.outputTokens ?? 0,
      change.cachedTokens ?? 0,
      change.analysisInput ?? null,
      change.analysisOutput ?? null,
    ],
  );
}

/**
 * The changes that belong to one calendar day.
 *
 * `change_date` is the day the content changed, computed from the capture
 * window - not the day a row happened to be written, and not the day the page
 * says it was published. A 2025 article edited yesterday belongs to
 * yesterday; a 2025 article merely re-found yesterday has no row at all.
 */
export async function changesForDate(date, { types = REPORTABLE } = {}) {
  const db = await getDb();
  const placeholders = types.map(() => '?').join(', ');
  return db.all(
    `SELECT c.*, w.name AS website_name, w.url AS website_url
     FROM detected_changes c
     JOIN websites w ON w.id = c.website_id
     WHERE c.change_date = ? AND c.change_type IN (${placeholders})
     ORDER BY CASE c.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
              w.name, c.id`,
    [date, ...types],
  );
}

export async function listChanges({ websiteId = null, date = null, limit = 100, offset = 0 } = {}) {
  const db = await getDb();
  const clauses = [];
  const params = [];
  if (websiteId) {
    clauses.push('c.website_id = ?');
    params.push(websiteId);
  }
  if (date) {
    clauses.push('c.change_date = ?');
    params.push(date);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit, offset);

  return db.all(
    `SELECT c.id, c.page_id, c.website_id, c.detected_at, c.change_date, c.change_type, c.priority,
            c.title, c.url, c.summary, c.what_changed, c.previous_value, c.new_value,
            c.analyzer, c.model, c.input_tokens, c.output_tokens, c.reported_in,
            w.name AS website_name
     FROM detected_changes c JOIN websites w ON w.id = c.website_id
     ${where}
     ORDER BY c.detected_at DESC, c.id DESC
     LIMIT ? OFFSET ?`,
    params,
  );
}

/** Full row including the audit payload: what Claude saw and what it said. */
export async function getChange(id) {
  const db = await getDb();
  return db.get(
    `SELECT c.*, w.name AS website_name, p.url AS page_url
     FROM detected_changes c
     JOIN websites w ON w.id = c.website_id
     LEFT JOIN pages p ON p.id = c.page_id
     WHERE c.id = ?`,
    [id],
  );
}

export async function attachToReport(ids, reportId) {
  if (!ids.length) return 0;
  const db = await getDb();
  let changed = 0;
  for (const id of ids) {
    const { changes } = await db.run('UPDATE detected_changes SET reported_in = ? WHERE id = ?', [
      reportId,
      id,
    ]);
    changed += changes;
  }
  return changed;
}

/** Token spend, so the dashboard can show what the analysis actually cost. */
export async function usageSince(sinceIso) {
  const db = await getDb();
  const row = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(cached_tokens), 0) AS cached
     FROM detected_changes WHERE detected_at >= ?`,
    [sinceIso],
  );
  return {
    analyses: num(row?.n),
    input_tokens: num(row?.input),
    output_tokens: num(row?.output),
    cached_tokens: num(row?.cached),
  };
}

export async function countByDate(date) {
  const db = await getDb();
  const rows = await db.all(
    'SELECT change_type, priority, COUNT(*) AS n FROM detected_changes WHERE change_date = ? GROUP BY change_type, priority',
    [date],
  );
  return rows.map((row) => ({ ...row, n: num(row.n) }));
}
