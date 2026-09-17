import { getDb, num, nowIso } from '../index.js';

/**
 * Una ejecución del pipeline, de principio a fin.
 *
 * La fila se abre ANTES de tocar la primera web y se cierra al terminar. Ese
 * orden es lo que permite que el panel diga "comprobación en curso" con algo
 * real detrás en lugar de con un temporizador: si hay una fila en `running`,
 * hay una pasada corriendo, y cuando pasa a `done` es porque terminó de
 * verdad. Nada se inventa ni se estima.
 *
 * Y cerrarla en un `finally` importa: una pasada que revienta a mitad tiene
 * que quedar marcada como `failed`, no quedarse en `running` para siempre
 * dejando al panel girando una rueda que ya no va a parar.
 */

const parse = (row) =>
  row && {
    ...row,
    errors: row.errors ? JSON.parse(row.errors) : [],
    slack_sent: num(row.slack_sent),
  };

/** Abre la ejecución. Devuelve la fila, cuyo id marca todo lo que venga. */
export async function startRun({ origin = 'automatico', at = nowIso() } = {}) {
  const db = await getDb();
  const row = await db.get(
    `INSERT INTO crawl_runs (started_at, status, origin) VALUES (?, 'running', ?) RETURNING *`,
    [at, origin],
  );
  return parse(row);
}

/**
 * Cierra la ejecución con lo que de verdad pasó.
 *
 * `errors` se guarda ya traducido a lenguaje de persona: aquí no entra un
 * ENOTFOUND ni un código HTTP, porque esta fila la lee el panel.
 */
export async function finishRun(id, summary = {}) {
  const db = await getDb();
  await db.run(
    `UPDATE crawl_runs SET
       finished_at = ?, status = ?, websites = ?, pages_seen = ?, pages_changed = ?,
       analyzed = ?, relevant = ?, ignored = ?, drafts = ?, websites_failed = ?,
       errors = ?, duration_ms = ?
     WHERE id = ?`,
    [
      summary.finishedAt ?? nowIso(),
      summary.status ?? 'done',
      summary.websites ?? 0,
      summary.pagesSeen ?? 0,
      summary.pagesChanged ?? 0,
      summary.analyzed ?? 0,
      summary.relevant ?? 0,
      summary.ignored ?? 0,
      summary.drafts ?? 0,
      summary.websitesFailed ?? 0,
      JSON.stringify(summary.errors ?? []),
      summary.durationMs ?? 0,
      id,
    ],
  );
  return getRun(id);
}

/** Lo que pasó con Slack en esta ejecución. Nunca guarda el webhook. */
export async function recordSlackOutcome(id, { sent = 0, error = null } = {}) {
  const db = await getDb();
  await db.run('UPDATE crawl_runs SET slack_sent = ?, slack_error = ? WHERE id = ?', [
    sent,
    error ? String(error).slice(0, 300) : null,
    id,
  ]);
}

export async function getRun(id) {
  const db = await getDb();
  return parse(await db.get('SELECT * FROM crawl_runs WHERE id = ?', [id]));
}

export async function listRuns(limit = 10) {
  const db = await getDb();
  const rows = await db.all('SELECT * FROM crawl_runs ORDER BY started_at DESC, id DESC LIMIT ?', [
    limit,
  ]);
  return rows.map(parse);
}

/** La última, sea cual sea su estado: es la que mira el panel. */
export async function latestRun() {
  const [run] = await listRuns(1);
  return run ?? null;
}

/**
 * Pasadas que se quedaron colgadas en `running`.
 *
 * En serverless una función puede morir sin ejecutar su `finally` -se agota el
 * tiempo, el contenedor se recicla-. Sin esto, una fila así dejaría al panel
 * diciendo "comprobación en curso" indefinidamente, que es justo la clase de
 * mentira que este proyecto ya ha pagado una vez.
 */
export async function expireStaleRuns({ olderThanMs = 20 * 60 * 1000, now = new Date() } = {}) {
  const db = await getDb();
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  const { changes } = await db.run(
    `UPDATE crawl_runs SET status = 'failed', finished_at = ?
     WHERE status = 'running' AND started_at < ?`,
    [now.toISOString(), cutoff],
  );
  return changes;
}
