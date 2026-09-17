import { Router } from 'express';
import {
  getWebsite,
  listWebsites,
  setActive,
  updateWebsite,
} from '../../db/repositories/websites.repo.js';
import { countPages, listPages } from '../../db/repositories/pages.repo.js';
import { listChanges } from '../../db/repositories/changes.repo.js';
import { listLogs } from '../../db/repositories/checkLogs.repo.js';
import { crawlWebsite } from '../../monitor/crawl.js';
import { aiConfigured, detectWithAi, previewWebsite } from '../../crawler/fetchers/index.js';
import { inspectWebsite } from '../../crawler/inspect.js';
import { explainError, publicError } from '../../monitor/errors.js';
import { asyncHandler } from '../middleware/errors.js';
import { parseWebsitePayload, ValidationError } from '../validate.js';

export const websiteRoutes = Router();

/**
 * Lo que sale al panel.
 *
 * `last_error` en crudo NO se publica: un código HTTP o un ENOTFOUND no le
 * dicen nada a quien vigila clubes de golf, y en cambio describen la
 * instalación a quien la quiera sondear. Va `status` traducido, y el detalle
 * técnico entero se queda en /api/diagnostics, tras la misma autenticación.
 */
const withStats = async (website) => {
  if (!website) return website;
  const { last_error: raw, ...rest } = website;
  return {
    ...rest,
    posts_count: await countPages(website.id),
    failing: Boolean(raw),
    status: publicError(raw, { consecutive: website.consecutive_errors ?? 0 }),
  };
};

websiteRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const websites = await listWebsites();
    res.json({ websites: await Promise.all(websites.map(withStats)) });
  }),
);

websiteRoutes.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const website = await getWebsite(Number(req.params.id));
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    return res.json({ website: await withStats(website) });
  }),
);

// No POST / and no DELETE /:id on purpose. The watched list lives in
// src/config/sites.js and is published on boot; nobody adds or removes a site
// through the dashboard, so the endpoints that would allow it do not exist.

/**
 * El detalle técnico de una web, para quien lo tenga que arreglar.
 *
 * Aquí sí va todo: el mensaje literal que guardó el crawler, el código y la
 * causa. Vive detrás de la misma autenticación que el resto de /api/websites
 * -a diferencia de /api/diagnostics, que es público- y el panel sólo lo pide
 * al abrir el historial de una web, nunca al pintar una tabla.
 */
websiteRoutes.get(
  '/:id/diagnostics',
  asyncHandler(async (req, res) => {
    const website = await getWebsite(Number(req.params.id));
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    return res.json({
      diagnostics: {
        url: website.url,
        last_checked_at: website.last_checked_at,
        last_success_at: website.last_success_at,
        last_error_at: website.last_error_at,
        consecutive_errors: website.consecutive_errors,
        error_count: website.error_count,
        raw: website.last_error ?? null,
        detail: explainError(website.last_error),
      },
    });
  }),
);

websiteRoutes.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload(req.body ?? {}, { partial: true });
    const website = await updateWebsite(Number(req.params.id), data);
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    return res.json({ website: await withStats(website) });
  }),
);

websiteRoutes.post(
  '/:id/toggle',
  asyncHandler(async (req, res) => {
    const current = await getWebsite(Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'Web no encontrada' });
    const next = req.body?.active === undefined ? !current.active : Boolean(req.body.active);
    return res.json({ website: await withStats(await setActive(current.id, next)) });
  }),
);

/**
 * Manual check: crawls this one website now and stores whatever moved.
 * It does NOT analyse or email - that is what the daily pass is for, and a
 * dashboard button must never be able to spend tokens by accident.
 */
websiteRoutes.post(
  '/:id/check',
  asyncHandler(async (req, res) => {
    const website = await getWebsite(Number(req.params.id));
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    const outcome = await crawlWebsite(website, { maxPages: 12 });
    return res.json({
      result: {
        ok: outcome.ok,
        error: outcome.error ?? null,
        itemsFound: outcome.pagesSeen ?? 0,
        newItems: outcome.pagesChanged ?? 0,
        baseline: Boolean(outcome.baseline),
        note: outcome.pagesFailed ? `${outcome.pagesFailed} página(s) con error` : null,
        notified: false,
      },
      website: await withStats(await getWebsite(website.id)),
    });
  }),
);

/** Dry-run used by the form: shows what the current configuration would find. */
websiteRoutes.post(
  '/preview',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload({ check_interval: 60, ...req.body });
    const preview = await previewWebsite({ ...data, id: 0, selector_config: data.selector_config });
    return res.json({ preview });
  }),
);

/**
 * Detection assisted by Claude: reads the page once and returns both the
 * publications it sees and the CSS selectors that describe them, so the
 * following checks are plain scraping - no cost per minute.
 */
websiteRoutes.post(
  '/ai-detect',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload({ check_interval: 60, ...req.body });
    const result = await detectWithAi({ ...data, id: 0 });
    return res.json({
      detection: {
        items: result.items.slice(0, 10),
        total: result.items.length,
        selectors: result.selectors,
        notes: result.notes,
        usage: result.usage,
      },
    });
  }),
);

websiteRoutes.get('/ai-status', (req, res) => res.json({ available: aiConfigured() }));

/** Shows what a page really contains, to configure a listing without guessing. */
websiteRoutes.post(
  '/inspect',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload({ check_interval: 60, name: 'Diagnóstico', ...req.body });
    return res.json({ inspection: await inspectWebsite(data) });
  }),
);

websiteRoutes.get(
  '/:id/posts',
  asyncHandler(async (req, res) => {
    const websiteId = Number(req.params.id);
    if (!(await getWebsite(websiteId))) return res.status(404).json({ error: 'Web no encontrada' });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    // Historically "posts". The history of a website is now its detected
    // changes and the pages being tracked for it.
    const [changes, pages] = await Promise.all([
      listChanges({ websiteId, limit }),
      listPages({ websiteId, limit }),
    ]);
    return res.json({ changes, pages, posts: changes });
  }),
);

websiteRoutes.get(
  '/:id/logs',
  asyncHandler(async (req, res) => {
    const websiteId = Number(req.params.id);
    if (!(await getWebsite(websiteId))) return res.status(404).json({ error: 'Web no encontrada' });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return res.json({ logs: await listLogs({ websiteId, limit }) });
  }),
);

websiteRoutes.use((error, req, res, next) => {
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
  return next(error);
});
