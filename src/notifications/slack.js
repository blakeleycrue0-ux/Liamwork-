import { config } from '../config/index.js';
import { CATEGORY_LABELS } from '../monitor/analyze.js';
import { claimForSlack, pendingForSlack, releaseSlackClaim } from '../db/repositories/changes.repo.js';

/**
 * Slack como tercer canal, al lado del correo y del panel.
 *
 * Tres reglas que no se negocian:
 *
 * 1. Es OPCIONAL. Sin webhook no hay error, no hay aviso en rojo y no hay
 *    nada roto: la función contesta "no configurado" y la pasada sigue. Un
 *    club que no use Slack no puede notar que esto existe.
 *
 * 2. Es INDEPENDIENTE. Todo lo que pasa aquí está envuelto: si Slack está
 *    caído, tarda, o devuelve un 500, el crawler termina, el panel enseña sus
 *    resultados y el informe sale por correo exactamente igual. Lo único que
 *    cambia es una línea en la fila de la ejecución diciendo qué falló.
 *
 * 3. NO DUPLICA. Un cambio se manda una vez en su vida. La reserva se toma
 *    antes de publicar, con un UPDATE que lleva la condición dentro, así que
 *    un reintento de la función -o dos ejecuciones a la vez- no puede mandar
 *    el mismo aviso dos veces. Ver claimForSlack().
 *
 * Y el webhook no sale de este módulo: no se devuelve, no se registra y no
 * aparece en ningún mensaje de error. Lo que se propaga hacia arriba es el
 * texto del fallo con la URL recortada.
 */

/** Lo único que el resto del sistema -y el panel- necesita saber. */
export const slackConfigured = () => Boolean(config.slack.webhookUrl);

/** Un mensaje por segundo es lo que admite un webhook de Slack. */
const GAP_MS = 1100;

const TYPE_LABEL = { NEW: 'NEW', UPDATED: 'UPDATED' };

/**
 * Quita de un mensaje de error cualquier rastro del webhook.
 *
 * `fetch` mete la URL en el texto de muchos errores de red ("request to
 * https://hooks.slack.com/services/T000/B000/xxxx failed"). Ese texto acaba en
 * crawl_runs.slack_error, que el panel lee. Sin esto, el secreto se publicaría
 * solo, por la puerta de atrás, el día que Slack diera un problema de red.
 */
export function scrubSecret(message) {
  const text = String(message ?? '');
  const webhook = config.slack.webhookUrl;
  const withoutUrls = text.replace(/https:\/\/hooks\.slack\.com\/\S+/g, 'el webhook de Slack');
  return webhook ? withoutUrls.split(webhook).join('el webhook de Slack') : withoutUrls;
}

/** Un bloque de texto de Slack, recortado a lo que el formato admite. */
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } });

/** Slack usa *negrita* y _cursiva_, así que esos caracteres hay que domarlos. */
const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * Un cambio relevante, en Block Kit.
 *
 * El formato es el que se pidió: titular con el icono de la categoría, la
 * ficha (club, categoría, tipo, prioridad), el resumen, el borrador entre
 * comillas y el enlace. El botón "Ver el cambio" lleva al panel.
 */
export function buildChangeMessage(change, { baseUrl = config.slack.appBaseUrl } = {}) {
  const kind = CATEGORY_LABELS[change.category] ?? { icon: '\u{1F514}', label: 'Cambio' };
  const type = TYPE_LABEL[change.change_type] ?? change.change_type;
  const headline = `${kind.icon} ${type === 'NEW' ? 'New' : 'Updated'} · ${kind.label}`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: headline.slice(0, 150), emoji: true } },
    section(
      [
        `*Club:* ${escape(change.website_name)}`,
        `*Category:* ${kind.label}`,
        `*Type:* ${type}`,
        `*Priority:* ${change.priority}`,
      ].join('\n'),
    ),
  ];

  if (change.title) blocks.push(section(`*${escape(change.title)}*`));

  const what = [change.summary, change.what_changed].filter(Boolean).join('\n');
  if (what) blocks.push(section(escape(what)));

  if (change.draft_message) {
    // Citado con "> " para que se lea como texto para copiar, no como una
    // frase más del aviso.
    const quoted = escape(change.draft_message)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    blocks.push(section(`\u{1F4AC} *Draft message:*\n${quoted}`));
  }

  // Los botones: el original y la ficha del cambio en el panel. Slack exige
  // que toda URL de un botón sea absoluta y http(s), así que se comprueba.
  const buttons = [];
  if (isHttpUrl(change.url)) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View original', emoji: true },
      url: change.url,
    });
  }
  const dashboard = changeUrl(baseUrl, change.id);
  if (dashboard) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View change', emoji: true },
      url: dashboard,
      style: 'primary',
    });
  }
  if (buttons.length) blocks.push({ type: 'actions', elements: buttons });

  blocks.push({ type: 'divider' });

  return {
    // El texto plano es lo que sale en la notificación del móvil y en los
    // clientes que no pintan bloques. Nunca debe ir vacío.
    text: `${headline} — ${change.website_name}: ${change.title ?? ''}`.slice(0, 250),
    blocks,
  };
}

const isHttpUrl = (value) => {
  if (!value) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const changeUrl = (baseUrl, id) => {
  if (!isHttpUrl(baseUrl) || !id) return null;
  return `${String(baseUrl).replace(/\/+$/, '')}/?change=${id}`;
};

/**
 * Publica un mensaje. Nunca lanza: devuelve si salió y, si no, por qué.
 *
 * El tiempo de espera es corto a propósito. Esto corre dentro de una función
 * serverless con un presupuesto, y Slack no es lo bastante importante como
 * para que su latencia se coma el tiempo del crawler.
 */
export async function postToSlack(message, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!slackConfigured()) return { ok: false, skipped: true, reason: 'no configurado' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(config.slack.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });

    if (!response.ok) {
      // El cuerpo de Slack ("invalid_payload", "channel_not_found") explica el
      // fallo y no contiene el webhook, pero se recorta igualmente.
      const body = await response.text().catch(() => '');
      return { ok: false, reason: scrubSecret(`Slack respondió ${response.status} ${body}`.trim()) };
    }
    return { ok: true };
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'Slack no respondió a tiempo' : error.message;
    return { ok: false, reason: scrubSecret(reason) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Todo el paso de Slack para una ejecución: elige, reserva, publica, anota.
 *
 * Sólo ve cambios REPORTABLE -lo que el filtro de relevancia dejó pasar- y
 * sólo los que nadie ha mandado todavía. Un IGNORED no puede llegar aquí.
 *
 * @returns {{configured, sent, skipped, failed, errors}}
 */
export async function notifyRunToSlack(runId, { fetchImpl = fetch, baseUrl, gapMs = GAP_MS } = {}) {
  const empty = { configured: false, sent: 0, skipped: 0, failed: 0, errors: [] };
  if (!slackConfigured()) return empty;

  const pending = await pendingForSlack(runId);
  const outcome = { ...empty, configured: true };
  let first = true;

  for (const change of pending) {
    // Los webhooks de Slack admiten alrededor de un mensaje por segundo. Una
    // ráfaga de veinte empieza a recibir 429, y un 429 aquí significa un aviso
    // que no llega. Esperar un segundo entre mensajes cuesta veinte segundos
    // dentro de una función que tiene quince minutos: no es un problema.
    if (!first && gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    first = false;

    // Primero la reserva. Si otra ejecución ya la tenía, este mensaje no es
    // nuestro y no se manda: así es como no llegan duplicados.
    const claimed = await claimForSlack(change.id);
    if (!claimed) {
      outcome.skipped += 1;
      continue;
    }

    const result = await postToSlack(buildChangeMessage(change, { baseUrl }), { fetchImpl });

    if (result.ok) {
      outcome.sent += 1;
    } else {
      // No salió: se devuelve la reserva para que el siguiente intento pueda
      // mandarlo. Un cambio no avisado es un problema menor; uno avisado dos
      // veces es el que hace que la gente silencie el canal.
      await releaseSlackClaim(change.id);
      outcome.failed += 1;
      if (result.reason && !outcome.errors.includes(result.reason)) {
        outcome.errors.push(result.reason);
      }
    }
  }

  return outcome;
}
