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
       change_type, priority, category, draft_message, title, url, summary, what_changed,
       previous_value, new_value, reasoning, analyzer, model, input_tokens, output_tokens,
       cached_tokens, analysis_input, analysis_output
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      // Solo las ponen los veredictos que pasan el filtro de relevancia; las
      // filas antiguas y las no analizadas se quedan en NULL, que es su verdad.
      change.category ?? null,
      change.draftMessage ?? null,
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
 * Everything a report for `date` should carry: that day's changes, PLUS any
 * relevant change from an earlier day that has never actually been emailed.
 *
 * The second half is the whole point. A change is dated by when it could have
 * happened, so a missed crawl - a site down, a failed function, a deploy -
 * files it under an older day. Selecting `change_date = ?` meant that change
 * was invisible to every report that came after, permanently. Now nothing can
 * fall through: a change leaves the pending set only when a report that
 * actually went out claimed it.
 *
 * `reported_in` is that claim, and it is written only after a successful send
 * (see sendDailyReport). The `reported_in = ?` arm keeps re-sending one date's
 * report idempotent: it reproduces the same content instead of dropping the
 * changes it already delivered.
 *
 * @param {object} options
 * @param {string} options.date      the day the report covers
 * @param {number|null} options.reportId  the stored report for that day, if any
 */
export async function changesForReport({ date, reportId = null, types = REPORTABLE } = {}) {
  const db = await getDb();
  const placeholders = types.map(() => '?').join(', ');
  return db.all(
    `SELECT c.*, w.name AS website_name, w.url AS website_url
     FROM detected_changes c
     JOIN websites w ON w.id = c.website_id
     WHERE c.change_type IN (${placeholders})
       AND c.change_date <= ?
       AND (c.reported_in IS NULL OR c.reported_in = ?)
     ORDER BY CASE c.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
              c.change_date, w.name, c.id`,
    [...types, date, reportId],
  );
}

/** How many changes the next report would carry, backlog included. */
export async function countPendingForReport({ date, reportId = null, types = REPORTABLE } = {}) {
  const db = await getDb();
  const placeholders = types.map(() => '?').join(', ');
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM detected_changes
     WHERE change_type IN (${placeholders})
       AND change_date <= ?
       AND (reported_in IS NULL OR reported_in = ?)`,
    [...types, date, reportId],
  );
  return num(row?.n);
}

/**
 * The changes that belong to one calendar day, and only that day.
 *
 * Used where the question really is "what happened on this date" - not for
 * building a report, which must also sweep up the backlog above.
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
            c.category, c.draft_message, c.title, c.url, c.summary, c.what_changed,
            c.previous_value, c.new_value,
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

/**
 * Marks changes as delivered. Called only after an email has actually left,
 * never at build time: a report that was previewed, or built and then failed
 * to send, must leave its changes pending.
 */
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
