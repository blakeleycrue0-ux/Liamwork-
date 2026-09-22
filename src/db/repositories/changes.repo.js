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
       page_id, website_id, run_id, from_version_id, to_version_id, detected_at, change_date,
       change_type, priority, category, draft_message, title, url, summary, what_changed,
       previous_value, new_value, reasoning, analyzer, model, input_tokens, output_tokens,
       cached_tokens, analysis_input, analysis_output
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (to_version_id, page_id) DO NOTHING
     RETURNING *`,
    [
      change.pageId ?? null,
      change.websiteId,
      // De qué pasada salió. Es lo que ata un resultado a su comprobación en
      // lugar de dejarlo flotando entre los cambios de toda la base de datos.
      change.runId ?? null,
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
export async function changesForReport({
  date,
  reportId = null,
  types = REPORTABLE,
  websiteIds = null,
} = {}) {
  const db = await getDb();
  const placeholders = types.map(() => '?').join(', ');
  const scope = scopeClause(websiteIds);
  return db.all(
    `SELECT c.*, w.name AS website_name, w.url AS website_url
     FROM detected_changes c
     JOIN websites w ON w.id = c.website_id
     WHERE c.change_type IN (${placeholders})
       AND c.change_date <= ?
       AND (c.reported_in IS NULL OR c.reported_in = ?)
       ${scope.sql}
     ORDER BY CASE c.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
              c.change_date, w.name, c.id`,
    [...types, date, reportId, ...scope.params],
  );
}

/**
 * El filtro de clubes del informe, en SQL.
 *
 * `null` o lista vacía significa "todos", y entonces no se añade cláusula
 * ninguna: un informe sin filtro tiene que producir exactamente la misma
 * consulta que antes de que esto existiera.
 */
function scopeClause(websiteIds) {
  if (!websiteIds?.length) return { sql: '', params: [] };
  return {
    sql: `AND c.website_id IN (${websiteIds.map(() => '?').join(', ')})`,
    params: websiteIds,
  };
}

/** How many changes the next report would carry, backlog included. */
export async function countPendingForReport({
  date,
  reportId = null,
  types = REPORTABLE,
  websiteIds = null,
} = {}) {
  const db = await getDb();
  const placeholders = types.map(() => '?').join(', ');
  // El mismo filtro que la consulta de arriba, porque el panel tiene que
  // contar lo que de verdad se va a enviar. Un contador que suma clubes que
  // nadie va a recibir no es un contador, es una trampa.
  const scope = scopeClause(websiteIds);
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM detected_changes c
     WHERE c.change_type IN (${placeholders})
       AND c.change_date <= ?
       AND (c.reported_in IS NULL OR c.reported_in = ?)
       ${scope.sql}`,
    [...types, date, reportId, ...scope.params],
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

/* ------------------------------------------------------- por ejecución */

/**
 * Lo que encontró UNA pasada concreta.
 *
 * No es "los cambios de las últimas dos horas" ni "los ocho más recientes":
 * es exactamente lo que produjo esa ejecución, atado por run_id. Un cambio no
 * puede aparecer en dos revisiones ni desaparecer porque otra pasada haya
 * escrito encima.
 */
export async function changesForRun(runId, { types = null } = {}) {
  const db = await getDb();
  const filter = types?.length ? `AND c.change_type IN (${types.map(() => '?').join(', ')})` : '';
  return db.all(
    `SELECT c.id, c.website_id, c.detected_at, c.change_date, c.change_type, c.priority,
            c.category, c.draft_message, c.title, c.url, c.summary, c.what_changed,
            c.previous_value, c.new_value, c.reasoning, c.slack_notified_at,
            w.name AS website_name, w.url AS website_url
     FROM detected_changes c JOIN websites w ON w.id = c.website_id
     WHERE c.run_id = ? ${filter}
     ORDER BY CASE c.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
              w.name, c.id`,
    [runId, ...(types ?? [])],
  );
}

/**
 * Los cambios relevantes de una pasada que NADIE ha mandado todavía a Slack.
 *
 * Aquí no se decide nada sobre relevancia: se pregunta por REPORTABLE, que es
 * lo que el filtro de relevancia ya dejó pasar. Un IGNORED no puede salir de
 * esta consulta ni aunque alguien lo pida.
 */
export async function pendingForSlack(runId) {
  const db = await getDb();
  const placeholders = REPORTABLE.map(() => '?').join(', ');
  return db.all(
    `SELECT c.id, c.change_type, c.priority, c.category, c.draft_message, c.title, c.url,
            c.summary, c.what_changed, c.detected_at,
            w.name AS website_name, w.url AS website_url
     FROM detected_changes c JOIN websites w ON w.id = c.website_id
     WHERE c.run_id = ? AND c.change_type IN (${placeholders}) AND c.slack_notified_at IS NULL
     ORDER BY CASE c.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, c.id`,
    [runId, ...REPORTABLE],
  );
}

/**
 * Se queda con el derecho a avisar de este cambio, y sólo si nadie lo tenía.
 *
 * El `AND slack_notified_at IS NULL` va DENTRO del UPDATE a propósito: leer
 * primero y escribir después deja una ventana en la que dos ejecuciones
 * simultáneas -un reintento de Netlify sobre una función que ya estaba
 * corriendo- pasan las dos la comprobación y mandan las dos el mensaje. Así
 * sólo una puede ganar, y la que pierde no manda nada.
 *
 * Se reclama ANTES de publicar, no después. Si el envío falla, se devuelve la
 * reserva; al revés, un fallo entre el envío y la marca produciría el
 * duplicado que esto existe para evitar.
 */
export async function claimForSlack(id, { at = nowIso() } = {}) {
  const db = await getDb();
  const { changes } = await db.run(
    'UPDATE detected_changes SET slack_notified_at = ? WHERE id = ? AND slack_notified_at IS NULL',
    [at, id],
  );
  return changes === 1;
}

/** Devuelve la reserva cuando el envío no llegó a salir. */
export async function releaseSlackClaim(id) {
  const db = await getDb();
  await db.run('UPDATE detected_changes SET slack_notified_at = NULL WHERE id = ?', [id]);
}
