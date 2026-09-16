import { getDb, nowIso } from '../index.js';

/** One row per morning summary, kept so a report can be re-read or re-sent. */

const parse = (row) =>
  row && {
    ...row,
    payload: safeJson(row.payload, {}),
    recipients: safeJson(row.recipients, []),
  };

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function saveReport(report, { at = nowIso() } = {}) {
  const db = await getDb();
  const payload = JSON.stringify(report.payload ?? {});

  const row = await db.get(
    `INSERT INTO daily_reports (
       report_date, generated_at, window_start, window_end, total_changes,
       high_priority, medium_priority, low_priority, websites_total, websites_quiet,
       daily_summary, payload, model, input_tokens, output_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (report_date) DO UPDATE SET
       generated_at = EXCLUDED.generated_at,
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       total_changes = EXCLUDED.total_changes,
       high_priority = EXCLUDED.high_priority,
       medium_priority = EXCLUDED.medium_priority,
       low_priority = EXCLUDED.low_priority,
       websites_total = EXCLUDED.websites_total,
       websites_quiet = EXCLUDED.websites_quiet,
       daily_summary = EXCLUDED.daily_summary,
       payload = EXCLUDED.payload,
       model = EXCLUDED.model,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens
     RETURNING *`,
    [
      report.date,
      at,
      report.windowStart,
      report.windowEnd,
      report.totalChanges ?? 0,
      report.highPriority ?? 0,
      report.mediumPriority ?? 0,
      report.lowPriority ?? 0,
      report.websitesTotal ?? 0,
      report.websitesQuiet ?? 0,
      report.dailySummary ?? null,
      payload,
      report.model ?? null,
      report.inputTokens ?? 0,
      report.outputTokens ?? 0,
    ],
  );
  return parse(row);
}

export async function markSent(reportDate, recipients, { at = nowIso() } = {}) {
  const db = await getDb();
  await db.run('UPDATE daily_reports SET sent_at = ?, recipients = ?, error = NULL WHERE report_date = ?', [
    at,
    JSON.stringify(recipients),
    reportDate,
  ]);
}

/**
 * Claims the right to send this date's report, atomically.
 *
 * Reading `sent_at` and then writing it is a race: two callers both read NULL,
 * both decide they are the sender, and two identical emails go out. Measured,
 * not theoretical - it happens when the button is pressed twice.
 *
 * So the claim IS the write. `WHERE sent_at IS NULL` makes the database pick a
 * winner: exactly one UPDATE can match, and whoever gets `changes === 1` owns
 * the send. The loser is told someone else has it and does nothing.
 *
 * @returns {Promise<boolean>} true for the one caller that may send
 */
export async function claimForSending(reportDate, recipients, { at = nowIso(), force = false } = {}) {
  const db = await getDb();
  const payload = [at, JSON.stringify(recipients), reportDate];

  // A forced re-send is deliberate and single-user, so it overwrites the
  // stamp; it still serialises, because only one UPDATE touches the row.
  const { changes } = force
    ? await db.run(
        'UPDATE daily_reports SET sent_at = ?, recipients = ?, error = NULL WHERE report_date = ?',
        payload,
      )
    : await db.run(
        'UPDATE daily_reports SET sent_at = ?, recipients = ?, error = NULL WHERE report_date = ? AND sent_at IS NULL',
        payload,
      );

  return changes === 1;
}

/**
 * Gives the claim back when the send failed, so the next run can try again.
 * Without this, one SMTP outage would mark the day as delivered for ever.
 */
export async function releaseClaim(reportDate, message) {
  const db = await getDb();
  await db.run(
    'UPDATE daily_reports SET sent_at = NULL, recipients = NULL, error = ? WHERE report_date = ?',
    [String(message).slice(0, 500), reportDate],
  );
}

export async function markFailed(reportDate, message) {
  const db = await getDb();
  await db.run('UPDATE daily_reports SET error = ? WHERE report_date = ?', [
    String(message).slice(0, 500),
    reportDate,
  ]);
}

export async function getReport(reportDate) {
  const db = await getDb();
  return parse(await db.get('SELECT * FROM daily_reports WHERE report_date = ?', [reportDate]));
}

export async function listReports(limit = 30) {
  const db = await getDb();
  const rows = await db.all(
    `SELECT id, report_date, generated_at, total_changes, high_priority, medium_priority,
            low_priority, websites_total, websites_quiet, daily_summary, model, sent_at, error
     FROM daily_reports ORDER BY report_date DESC LIMIT ?`,
    [limit],
  );
  return rows;
}

export async function lastSentDate() {
  const db = await getDb();
  const row = await db.get(
    'SELECT report_date FROM daily_reports WHERE sent_at IS NOT NULL ORDER BY report_date DESC LIMIT 1',
  );
  return row?.report_date ?? null;
}
