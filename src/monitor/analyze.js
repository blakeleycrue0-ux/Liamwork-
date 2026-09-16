import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { getSetting } from '../db/repositories/settings.repo.js';
import { getVersion } from '../db/repositories/pages.repo.js';
import { recordChange } from '../db/repositories/changes.repo.js';
import { decodeLine, decodeText } from '../crawler/encoding.js';
import { changeRatio, renderDiff } from './diff.js';

/**
 * Stage two: Claude decides what actually happened.
 *
 * The crawler can only say "these bytes differ". That is not the same
 * question as "did something happen that a person should be told about", and
 * answering the first as if it were the second is what produced a daily email
 * full of cookie banners and re-found 2025 articles.
 *
 * So the model is given, for each candidate: what the page said before, what
 * it says now (as a diff), what the page declares about its own publication
 * date, and whether the crawler had ever seen the URL before. It answers with
 * a classification, a priority, and a plain-language description of the
 * change - and everything it was shown and everything it replied is stored.
 */

export const DEFAULT_MODEL = 'claude-opus-5';

const VerdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string().describe('El id del candidato, copiado tal cual'),
        change_type: z
          .enum(['NEW', 'UPDATED', 'UNCHANGED', 'IGNORED'])
          .describe(
            'NEW: contenido realmente nuevo, publicado en la ventana analizada. ' +
              'UPDATED: contenido que ya existía y ha cambiado de forma sustantiva. ' +
              'UNCHANGED: nada relevante ha cambiado, incluido contenido antiguo que sigue publicado. ' +
              'IGNORED: ha cambiado técnicamente pero no aporta información (cookies, menús, anuncios, contadores, fechas dinámicas).',
          ),
        priority: z
          .enum(['HIGH', 'MEDIUM', 'LOW'])
          .describe(
            'HIGH: noticia importante, evento nuevo, convocatoria, cambio de horario o de fecha, cambio de normativa, aviso importante. ' +
              'MEDIUM: noticia normal o actualización relevante pero secundaria. ' +
              'LOW: cambio pequeño que no aporta información nueva. ' +
              'Para UNCHANGED e IGNORED usa siempre LOW.',
          ),
        title: z.string().describe('Titular corto de lo ocurrido, en el idioma de la web'),
        summary: z.string().describe('Una o dos frases en español: qué ha pasado y por qué importa. Vacío si no es NEW ni UPDATED.'),
        what_changed: z.string().describe('Qué cambió exactamente y dónde. Vacío si no es NEW ni UPDATED.'),
        previous_value: z.string().describe('El texto anterior concreto, si el cambio sustituye un valor. Si no, cadena vacía.'),
        new_value: z.string().describe('El texto nuevo concreto, si el cambio sustituye un valor. Si no, cadena vacía.'),
        reasoning: z.string().describe('Una frase: por qué esta clasificación y no otra. Para la auditoría.'),
      }),
    )
    .describe('Un veredicto por cada candidato recibido, en el mismo orden'),
});

/**
 * The system prompt is frozen and cached: it is the same bytes on every call,
 * every day, so after the first request of a run it is billed at a tenth.
 * Nothing volatile may be added to it - a date here would silently disable
 * caching for the whole system.
 */
const SYSTEM = `Eres el analista de un sistema que vigila páginas web de clubes deportivos y organizaciones.

Recibes candidatos a cambio. Cada candidato es una página que el crawler ha visto distinta respecto a la última captura, o una URL que no había visto nunca. Tu trabajo es decidir, para cada uno, si ha ocurrido algo que una persona deba saber.

REGLA FUNDAMENTAL
"El crawler ha encontrado esta URL por primera vez" NO significa "es una publicación nueva".
El crawler solo mira las primeras entradas de cada listado, así que descubre constantemente páginas antiguas que llevaban años publicadas.
Fíjate SIEMPRE en la fecha que la propia página declara:
- Publicada dentro de la ventana analizada -> puede ser NEW.
- Publicada antes de la ventana y sin cambios de contenido -> UNCHANGED, aunque el crawler acabe de descubrirla.
- Sin fecha declarada -> decide por el contenido: si el texto habla de algo que ocurre o se anuncia ahora, NEW; si es una página permanente (historia del club, contacto, normativa), UNCHANGED.

QUÉ ES UN CAMBIO REAL
Cuenta como UPDATED un cambio en la información: fechas, horarios, resultados, precios, nombres, plazos, normas, texto de una noticia, nuevos apartados.

QUÉ NO CUENTA (clasifica como IGNORED)
- Banners de cookies, avisos de consentimiento, RGPD.
- Menús, migas de pan, pies de página, enlaces a redes sociales.
- Anuncios, patrocinadores rotatorios, carruseles de imágenes.
- Contadores de visitas, "última actualización" automática, marcas de tiempo dinámicas.
- Reordenaciones sin contenido nuevo, cambios de maquetación, cambios de HTML.
- Cambios de idioma de la interfaz.
- Texto idéntico que solo se ha movido de sitio.

PRIORIDAD
HIGH se reserva para lo que cambia lo que alguien tiene que hacer: una convocatoria, un evento nuevo, un cambio de fecha u horario, un cambio de normativa, un aviso importante, una noticia destacada.
MEDIUM es una noticia normal o una actualización secundaria.
LOW es un retoque menor.
No infles la prioridad: un informe lleno de HIGH no sirve de nada.

FORMA DE RESPONDER
- Devuelve exactamente un veredicto por candidato, con el mismo id.
- summary y what_changed en español, claros y concretos, sin jerga técnica. Nunca "se ha detectado un cambio en el elemento": di qué ha pasado.
- Si el cambio sustituye un valor (una fecha, una hora, un precio), rellena previous_value y new_value con el valor exacto.
- No inventes nada que no esté en el texto. Si el contenido es ambiguo, dilo en reasoning y baja la prioridad.`;

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** Pages below this much movement are noise; they never reach the model. */
const MIN_RATIO = 0.005;
const MIN_CHANGED_CHARS = 40;

/**
 * Builds what the model reads for one candidate.
 * Returns null when the candidate is too trivial to be worth a token.
 */
export async function buildCandidate(candidate, { maxDiffChars = 6000 } = {}) {
  const current = await getVersion(candidate.versionId);
  if (!current) return null;

  const previous = candidate.previousVersionId ? await getVersion(candidate.previousVersionId) : null;
  const id = `c${candidate.pageId}v${candidate.versionId}`;

  const header = [
    `web: ${decodeLine(candidate.websiteName)}`,
    `url: ${candidate.url}`,
    `titulo: ${decodeLine(current.title || candidate.title || '')}`,
    `fecha que declara la pagina: ${current.published_at ?? 'ninguna'}`,
    `fecha de modificacion que declara: ${current.modified_at ?? 'ninguna'}`,
  ];

  if (!previous) {
    // A URL the crawler had never fetched. Whether that makes it news is
    // precisely the judgement the model is here to make, so it is told
    // exactly that and nothing is assumed on its behalf.
    header.push('estado: el crawler no habia visto nunca esta URL (esto NO implica que sea nueva)');
    return {
      id,
      pageId: candidate.pageId,
      websiteId: candidate.websiteId,
      versionId: candidate.versionId,
      previousVersionId: null,
      url: candidate.url,
      title: decodeLine(current.title || candidate.title || ''),
      publishedAt: current.published_at ?? null,
      text: `${header.join('\n')}\n\nCONTENIDO DE LA PAGINA:\n${decodeText(current.text).slice(0, maxDiffChars)}`,
      ratio: 1,
    };
  }

  const ratio = changeRatio(previous.text, current.text);
  const diff = renderDiff(previous.text, current.text, { maxChars: maxDiffChars });
  const changedChars =
    diff.addedLines.join('').length + diff.removedLines.join('').length;

  if (ratio < MIN_RATIO && changedChars < MIN_CHANGED_CHARS) return null;

  header.push(
    `estado: la pagina ya existia y su texto ha cambiado`,
    `magnitud: ${Math.round(ratio * 100)}% del texto, ${diff.added} linea(s) anadida(s), ${diff.removed} quitada(s)${
      diff.truncated ? ' (diff recortado)' : ''
    }`,
  );

  return {
    id,
    pageId: candidate.pageId,
    websiteId: candidate.websiteId,
    versionId: candidate.versionId,
    previousVersionId: candidate.previousVersionId,
    url: candidate.url,
    title: decodeLine(current.title || candidate.title || ''),
    publishedAt: current.published_at ?? null,
    text: `${header.join('\n')}\n\nCAMBIOS (- antes, + ahora):\n${diff.text}`,
    ratio,
  };
}

/** Splits candidates into calls small enough to stay well inside the window. */
export function batchCandidates(candidates, { maxPerCall = 6, maxCharsPerCall = 24_000 } = {}) {
  const batches = [];
  let current = [];
  let size = 0;

  for (const candidate of candidates) {
    const length = candidate.text.length;
    if (current.length && (current.length >= maxPerCall || size + length > maxCharsPerCall)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(candidate);
    size += length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function renderBatch(candidates, window) {
  const blocks = candidates.map(
    (candidate) => `<candidato id="${candidate.id}">\n${candidate.text}\n</candidato>`,
  );
  return [
    `Ventana analizada: del ${window.start} al ${window.end} (zona horaria ${window.timeZone}).`,
    'Solo cuenta como NEW lo publicado dentro de esa ventana. Lo anterior que siga publicado es UNCHANGED.',
    '',
    `Candidatos (${candidates.length}):`,
    '',
    ...blocks,
  ].join('\n');
}

/**
 * Asks Claude to classify one batch.
 * NEVER throws: an API failure must not lose the rest of the day's analysis.
 */
export async function analyzeBatch(candidates, { window, model, client } = {}) {
  const prompt = renderBatch(candidates, window);
  const anthropic = client ?? new Anthropic();

  try {
    const response = await anthropic.messages.parse({
      model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: zodOutputFormat(VerdictSchema) },
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal' || !response.parsed_output) {
      return { ok: false, error: 'el modelo no devolvió un resultado analizable', prompt };
    }

    return {
      ok: true,
      prompt,
      verdicts: response.parsed_output.verdicts,
      model: response.model ?? model,
      usage: {
        input: response.usage?.input_tokens ?? 0,
        output: response.usage?.output_tokens ?? 0,
        cached: response.usage?.cache_read_input_tokens ?? 0,
      },
    };
  } catch (error) {
    console.error(`[analyze] batch failed: ${error.message}`);
    return { ok: false, error: error.message, prompt };
  }
}

/**
 * Full stage two: build the inputs, ask the model, store every verdict.
 *
 * @returns {Promise<{analyzed, reported, skipped, batches, usage, errors}>}
 */
export async function analyzeCandidates(rawCandidates, { window, changeDate, model, client } = {}) {
  const chosenModel = model ?? (await getSetting('analysis_model', DEFAULT_MODEL));

  const built = [];
  let skipped = 0;
  for (const candidate of rawCandidates) {
    const prepared = await buildCandidate(candidate).catch(() => null);
    if (prepared) built.push(prepared);
    else skipped += 1;
  }

  if (!built.length) {
    return { analyzed: 0, reported: 0, skipped, batches: 0, usage: emptyUsage(), errors: [] };
  }

  if (!aiConfigured()) {
    // No key: every candidate is stored unclassified rather than silently
    // dropped, so nothing is lost and the gap is visible in the audit.
    for (const candidate of built) await storeUnanalyzed(candidate, changeDate);
    return {
      analyzed: 0,
      reported: 0,
      skipped,
      batches: 0,
      usage: emptyUsage(),
      errors: ['ANTHROPIC_API_KEY no está configurada: no se ha analizado nada'],
    };
  }

  const anthropic = client ?? new Anthropic();
  const batches = batchCandidates(built);
  const usage = emptyUsage();
  const errors = [];
  let analyzed = 0;
  let reported = 0;

  for (const batch of batches) {
    const result = await analyzeBatch(batch, { window, model: chosenModel, client: anthropic });

    if (!result.ok) {
      errors.push(result.error);
      for (const candidate of batch) await storeUnanalyzed(candidate, changeDate, result.error);
      continue;
    }

    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cached += result.usage.cached;

    const byId = new Map(result.verdicts.map((verdict) => [verdict.id, verdict]));
    for (const candidate of batch) {
      const verdict = byId.get(candidate.id);
      if (!verdict) {
        await storeUnanalyzed(candidate, changeDate, 'el modelo no devolvió veredicto para esta página');
        continue;
      }
      analyzed += 1;
      if (verdict.change_type === 'NEW' || verdict.change_type === 'UPDATED') reported += 1;

      await recordChange({
        pageId: candidate.pageId,
        websiteId: candidate.websiteId,
        fromVersionId: candidate.previousVersionId,
        toVersionId: candidate.versionId,
        changeDate,
        changeType: verdict.change_type,
        priority: verdict.change_type === 'NEW' || verdict.change_type === 'UPDATED' ? verdict.priority : 'LOW',
        title: verdict.title || candidate.title,
        url: candidate.url,
        summary: verdict.summary,
        whatChanged: verdict.what_changed,
        previousValue: verdict.previous_value,
        newValue: verdict.new_value,
        reasoning: verdict.reasoning,
        analyzer: 'claude',
        model: result.model,
        inputTokens: Math.round(result.usage.input / batch.length),
        outputTokens: Math.round(result.usage.output / batch.length),
        cachedTokens: Math.round(result.usage.cached / batch.length),
        analysisInput: candidate.text,
        analysisOutput: JSON.stringify(verdict),
      });
    }
  }

  return { analyzed, reported, skipped, batches: batches.length, usage, errors };
}

const emptyUsage = () => ({ input: 0, output: 0, cached: 0 });

/**
 * A candidate the model never judged. Recorded as UNCHANGED so it is never
 * mailed out, but kept in full so the gap is auditable and re-runnable.
 */
async function storeUnanalyzed(candidate, changeDate, error = 'no analizado') {
  await recordChange({
    pageId: candidate.pageId,
    websiteId: candidate.websiteId,
    fromVersionId: candidate.previousVersionId,
    toVersionId: candidate.versionId,
    changeDate,
    changeType: 'UNCHANGED',
    priority: 'LOW',
    title: candidate.title,
    url: candidate.url,
    reasoning: error,
    analyzer: 'none',
    analysisInput: candidate.text,
  });
}

export { SYSTEM as ANALYSIS_SYSTEM_PROMPT, VerdictSchema };
