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

const withStats = (website) => ({ ...website, posts_count: countPostsByWebsite(website.id) });

websiteRoutes.get('/', (req, res) => {
  res.json({ websites: listWebsites().map(withStats) });
});

websiteRoutes.get('/:id', (req, res) => {
  const website = getWebsite(Number(req.params.id));
  if (!website) return res.status(404).json({ error: 'Web no encontrada' });
  return res.json({ website: withStats(website) });
});

websiteRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload(req.body ?? {});
    res.status(201).json({ website: withStats(createWebsite(data)) });
  }),
);

websiteRoutes.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = parseWebsitePayload(req.body ?? {}, { partial: true });
    const website = updateWebsite(Number(req.params.id), data);
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    return res.json({ website: withStats(website) });
  }),
);

websiteRoutes.delete('/:id', (req, res) => {
  const removed = deleteWebsite(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Web no encontrada' });
  return res.json({ ok: true });
});

websiteRoutes.post('/:id/toggle', (req, res) => {
  const current = getWebsite(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Web no encontrada' });
  const next = req.body?.active === undefined ? !current.active : Boolean(req.body.active);
  return res.json({ website: withStats(setActive(current.id, next)) });
});

/** Manual check, runs immediately in this process and returns the outcome. */
websiteRoutes.post(
  '/:id/check',
  asyncHandler(async (req, res) => {
    const website = getWebsite(Number(req.params.id));
    if (!website) return res.status(404).json({ error: 'Web no encontrada' });
    const result = await checkWebsite(website, { force: true });
    return res.json({ result, website: withStats(getWebsite(website.id)) });
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

websiteRoutes.get('/:id/posts', (req, res) => {
  const websiteId = Number(req.params.id);
  if (!getWebsite(websiteId)) return res.status(404).json({ error: 'Web no encontrada' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  return res.json({ posts: listPosts({ websiteId, limit }) });
});

websiteRoutes.get('/:id/logs', (req, res) => {
  const websiteId = Number(req.params.id);
  if (!getWebsite(websiteId)) return res.status(404).json({ error: 'Web no encontrada' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  return res.json({ logs: listLogs({ websiteId, limit }) });
});

websiteRoutes.use((error, req, res, next) => {
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
  return next(error);
});
