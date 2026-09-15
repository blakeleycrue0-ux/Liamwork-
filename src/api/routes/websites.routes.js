import { Router } from 'express';
import {
  createWebsite,
  deleteWebsite,
  getWebsite,
  listWebsites,
  setActive,
  updateWebsite,
} from '../../db/repositories/websites.repo.js';
import { countPostsByWebsite, listPosts } from '../../db/repositories/posts.repo.js';
import { listLogs } from '../../db/repositories/checkLogs.repo.js';
import { checkWebsite } from '../../crawler/index.js';
import { previewWebsite } from '../../crawler/fetchers/index.js';
import { asyncHandler } from '../middleware/errors.js';
import { parseWebsitePayload, ValidationError } from '../validate.js';

export const websiteRoutes = Router();

const withStats = async (website) =>
  website && { ...website, posts_count: await countPostsByWebsite(website.id) };

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

websiteRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload(req.body ?? {});
    res.status(201).json({ website: await withStats(await createWebsite(data)) });
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

websiteRoutes.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const removed = await deleteWebsite(Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Web no encontrada' });
    return res.json({ ok: true });
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

/** Manual check, runs immediately in this process and returns the outcome. */
websiteRoutes.post(
  '/:id/check',
  asyncHandler(async (req, res) => {
    const website = await getWebsite(Number(req.params.id));
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    const result = await checkWebsite(website, { force: true });
    return res.json({ result, website: await withStats(await getWebsite(website.id)) });
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

websiteRoutes.get(
  '/:id/posts',
  asyncHandler(async (req, res) => {
    const websiteId = Number(req.params.id);
    if (!(await getWebsite(websiteId))) return res.status(404).json({ error: 'Web no encontrada' });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    return res.json({ posts: await listPosts({ websiteId, limit }) });
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
