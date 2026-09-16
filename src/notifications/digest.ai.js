import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { aiConfigured } from '../crawler/fetchers/ai.fetcher.js';
import { getBool } from '../db/repositories/settings.repo.js';

/**
 * Turns the day's raw detections into a briefing a person actually wants to
 * read: grouped by topic, with the important things first and a one-line
 * headline. One call a day, so the cost is negligible.
 */
const DigestSchema = z.object({
  headline: z.string().describe('Una frase que resuma el día. Sin relleno, concreta.'),
  sections: z
    .array(
      z.object({
        title: z.string().describe('Nombre de la sección, p. ej. "Partidos", "Clasificación"'),
        emoji: z.string().describe('Un emoji que represente la sección'),
        items: z
          .array(
            z.object({
              text: z.string().describe('Qué ha cambiado, en una frase clara'),
              website: z.string().describe('Nombre de la web de donde viene'),
              url: z.string().describe('Enlace, o cadena vacía si no lo hay'),
            }),
          )
          .describe('Novedades de esta sección'),
      }),
    )
    .describe('Secciones temáticas, de más a menos importante'),
});

const SYSTEM = `Escribes el resumen diario de un sistema que vigila páginas web.

Recibes las novedades detectadas hoy y las conviertes en un briefing claro:

- Agrupa por TEMA, no por web: partidos, clasificación, inscripciones, torneos, horarios, patrocinadores, avisos... Usa los nombres que pidan los propios datos.
- Lo más relevante primero.
- Una frase por novedad, en español, directa y sin jerga. Nada de "se ha detectado un cambio en el elemento": di qué ha pasado.
- No inventes nada que no esté en los datos. Si un título es críptico, dilo tal cual.
- Si todo es de un mismo tema, una sola sección está bien.`;

/** Fallback with no model: group by website, which is always correct. */
function groupByWebsite(posts) {
  const byWebsite = new Map();
  for (const post of posts) {
    if (!byWebsite.has(post.website_name)) byWebsite.set(post.website_name, []);
    byWebsite.get(post.website_name).push(post);
  }
  return {
    headline: `${posts.length} novedad${posts.length === 1 ? '' : 'es'} detectada${posts.length === 1 ? '' : 's'}`,
    generatedByAi: false,
    sections: [...byWebsite.entries()].map(([website, items]) => ({
      title: website,
      emoji: '•',
      items: items.map((post) => ({ text: post.title, website, url: post.url ?? '' })),
    })),
  };
}

export async function summariseDigest(posts, { timeZone, date } = {}) {
  if (!posts.length) {
    return { headline: 'Sin novedades hoy', sections: [], generatedByAi: false };
  }
  // Explicitly chosen for cost: writing a daily briefing is a small job, and
  // this keeps the monthly bill in the cents. Can be switched off entirely.
  if (!aiConfigured() || !(await getBool('digest_ai_enabled', true))) {
    return groupByWebsite(posts);
  }

  try {
    const client = new Anthropic();
    const lines = posts
      .map(
        (post) =>
          `- [${post.website_name}] ${post.title}${post.url ? ` (${post.url})` : ''}${
            post.published_at ? ` · publicado ${post.published_at}` : ''
          }`,
      )
      .join('\n');

    const response = await client.messages.parse({
      model: 'claude-haiku-4-5',
      max_tokens: 4000,
      system: SYSTEM,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      output_config: { format: zodOutputFormat(DigestSchema) },
      messages: [
        {
          role: 'user',
          content: `Resumen del día ${date} (zona horaria ${timeZone}).\n\nNovedades detectadas:\n\n${lines}`,
        },
      ],
    });

    if (response.stop_reason === 'refusal' || !response.parsed_output) return groupByWebsite(posts);
    return { ...response.parsed_output, generatedByAi: true };
  } catch (error) {
    console.error(`[digest] AI summary failed: ${error.message}`);
    return groupByWebsite(posts);
  }
}
