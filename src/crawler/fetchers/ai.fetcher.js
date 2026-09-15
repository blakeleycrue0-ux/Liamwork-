import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as cheerio from 'cheerio';
import { config } from '../../config/index.js';
import { fetchText } from '../httpClient.js';
import { dedupeItems, toItem } from '../normalize.js';

/**
 * Detection assisted by Claude, for websites whose listing neither publishes a
 * feed nor matches any structural pattern.
 *
 * It is used deliberately, not on every check: the model reads the page once
 * and returns both the publications it can see AND the CSS selectors that
 * describe them. Saving those selectors means the following checks are plain
 * scraping - no tokens, no latency, no cost per minute.
 */
const DetectionSchema = z.object({
  items: z
    .array(
      z.object({
        title: z.string().describe('Titular de la publicación, tal cual aparece'),
        url: z.string().describe('Enlace a la publicación; absoluto o relativo'),
        date: z.string().describe('Fecha publicada tal cual aparece, o cadena vacía'),
      }),
    )
    .describe('Publicaciones del listado, de más reciente a más antigua'),
  selectors: z
    .object({
      list: z.string().describe('Selector CSS del contenedor de CADA publicación'),
      title: z.string().describe('Selector del título dentro del contenedor, o cadena vacía'),
      link: z.string().describe('Selector del enlace dentro del contenedor, o cadena vacía'),
      date: z.string().describe('Selector de la fecha dentro del contenedor, o cadena vacía'),
    })
    .describe('Selectores para repetir esta extracción sin usar el modelo'),
  notes: z.string().describe('Una frase: qué es este listado, o por qué no se encontró nada'),
});

const SYSTEM = `Extraes listados de publicaciones (noticias, avisos, convocatorias, posts) de páginas web.

Reglas:
- Solo publicaciones reales del listado principal. Nunca menús, pies de página, banners de cookies, enlaces a redes sociales ni paginación.
- Los selectores CSS deben ser estables: prefiere clases descriptivas a rutas frágiles basadas en posición.
- "list" debe seleccionar el contenedor que se REPITE una vez por publicación.
- Si la página no contiene ningún listado de publicaciones, devuelve items vacío y explica por qué en notes.`;

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

/** Cuts the page down to what matters: no scripts, styles, svg or comments. */
export function reduceHtml(html, maxChars = 120_000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta').remove();
  $('*').each((_, element) => {
    const attribs = element.attribs ?? {};
    for (const name of Object.keys(attribs)) {
      if (!['class', 'id', 'href', 'datetime', 'title'].includes(name)) {
        $(element).removeAttr(name);
      }
    }
  });
  const main = $('main').html() || $('body').html() || html;
  return main.replace(/\s+/g, ' ').slice(0, maxChars);
}

/**
 * Asks Claude what this page publishes.
 * @returns {Promise<{items, selectors, notes, usage}>}
 */
export async function detectWithAi(website) {
  if (!aiConfigured()) {
    const error = new Error(
      'La detección con IA necesita una clave de Anthropic (ANTHROPIC_API_KEY) en las variables de entorno.',
    );
    error.status = 501;
    throw error;
  }

  const { body, finalUrl } = await fetchText(website.url);
  const client = new Anthropic();

  const response = await client.messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: zodOutputFormat(DetectionSchema) },
    messages: [
      {
        role: 'user',
        content: `Página: ${finalUrl}\n\nHTML (limpio y recortado):\n\n${reduceHtml(body)}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('El modelo rechazó analizar esta página');
  }

  const parsed = response.parsed_output;
  if (!parsed) throw new Error('El modelo no devolvió un resultado analizable');

  const items = dedupeItems(
    parsed.items
      .map((item) => toItem({ title: item.title, url: item.url, publishedAt: item.date || null }, finalUrl))
      .filter(Boolean),
  );

  return {
    items,
    selectors: parsed.selectors,
    notes: parsed.notes,
    source: finalUrl,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

/** Fetcher interface, for websites configured with detection_method 'ai'. */
export async function fetchViaAi(website) {
  const result = await detectWithAi(website);
  return { items: result.items, method: 'ai', source: result.source };
}
