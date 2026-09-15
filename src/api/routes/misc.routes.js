import { Router } from 'express';
import { listPosts } from '../../db/repositories/posts.repo.js';
import { listLogs } from '../../db/repositories/checkLogs.repo.js';
import { getAllSettings, setSettings } from '../../db/repositories/settings.repo.js';
import { verifyTransport } from '../../notifications/mailer.js';
import { activeRecipients } from '../../notifications/notifier.js';
import { asyncHandler } from '../middleware/errors.js';
import { ValidationError } from '../validate.js';

export const postRoutes = Router();
postRoutes.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const websiteId = req.query.website_id ? Number(req.query.website_id) : null;
  res.json({ posts: listPosts({ limit, websiteId }) });
});

export const logRoutes = Router();
logRoutes.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const websiteId = req.query.website_id ? Number(req.query.website_id) : null;
  const onlyErrors = String(req.query.errors ?? '') === 'true';
  res.json({ logs: listLogs({ limit, websiteId, onlyErrors }) });
});

const NUMERIC_SETTINGS = {
  default_check_interval: [10, 86400],
  scheduler_tick: [5, 3600],
  crawler_concurrency: [1, 64],
  max_items_per_email: [1, 100],
  log_retention_days: [0, 365],
};
const BOOL_SETTINGS = ['notify_on_first_check', 'crawler_enabled'];

export const settingsRoutes = Router();
settingsRoutes.get('/', (req, res) => {
  res.json({ settings: getAllSettings(), recipients: activeRecipients() });
});

settingsRoutes.put(
  '/',
  asyncHandler(async (req, res) => {
    const patch = {};
    for (const [key, range] of Object.entries(NUMERIC_SETTINGS)) {
      if (req.body?.[key] === undefined) continue;
      const value = Number.parseInt(req.body[key], 10);
      if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
        throw new ValidationError(`${key} debe estar entre ${range[0]} y ${range[1]}`);
      }
      patch[key] = value;
    }
    for (const key of BOOL_SETTINGS) {
      if (req.body?.[key] === undefined) continue;
      patch[key] = Boolean(req.body[key]);
    }
    res.json({ settings: setSettings(patch) });
  }),
);

settingsRoutes.post(
  '/verify-mail',
  asyncHandler(async (req, res) => {
    const result = await verifyTransport();
    res.json(result);
  }),
);

for (const router of [postRoutes, logRoutes, settingsRoutes]) {
  router.use((error, req, res, next) => {
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    return next(error);
  });
}
