import { Router } from 'express';
import { listChanges } from '../../db/repositories/changes.repo.js';
import { listLogs } from '../../db/repositories/checkLogs.repo.js';
import { getAllSettings, setSettings } from '../../db/repositories/settings.repo.js';
import { verifyTransport } from '../../notifications/mailer.js';
import { activeRecipients } from '../../notifications/notifier.js';
import { asyncHandler } from '../middleware/errors.js';
import { ValidationError } from '../validate.js';

/**
 * Historically /api/posts. It now serves detected changes, which is what the
 * dashboard's activity view is actually about.
 */
export const postRoutes = Router();
postRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const websiteId = req.query.website_id ? Number(req.query.website_id) : null;
    const changes = await listChanges({ limit, websiteId, date: req.query.date || null });
    res.json({ changes, posts: changes });
  }),
);

export const logRoutes = Router();
logRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const websiteId = req.query.website_id ? Number(req.query.website_id) : null;
    const onlyErrors = String(req.query.errors ?? '') === 'true';
    res.json({ logs: await listLogs({ limit, websiteId, onlyErrors }) });
  }),
);

const NUMERIC_SETTINGS = {
  default_check_interval: [10, 86400],
  scheduler_tick: [5, 3600],
  crawler_concurrency: [1, 64],
  max_items_per_email: [1, 100],
  log_retention_days: [0, 365],
  ai_recovery_min_hours: [1, 168],
  digest_hour: [0, 23],
  max_pages_per_website: [1, 100],
};
const BOOL_SETTINGS = [
  'notify_on_first_check',
  'crawler_enabled',
  'ai_recovery_enabled',
  'digest_ai_enabled',
  'report_send_when_empty',
  'report_include_low',
];

export const settingsRoutes = Router();
settingsRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ settings: await getAllSettings(), recipients: await activeRecipients() });
  }),
);

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
    for (const key of ['notification_mode', 'digest_timezone', 'analysis_model']) {
      if (req.body?.[key] === undefined) continue;
      const value = String(req.body[key]).trim();
      if (key === 'notification_mode' && !['digest', 'instant'].includes(value)) {
        throw new ValidationError('El modo de aviso debe ser "digest" o "instant"');
      }
      if (key === 'digest_timezone') {
        try {
          new Intl.DateTimeFormat('en-CA', { timeZone: value });
        } catch {
          throw new ValidationError('Zona horaria no válida');
        }
      }
      patch[key] = value;
    }
    for (const key of BOOL_SETTINGS) {
      if (req.body?.[key] === undefined) continue;
      patch[key] = Boolean(req.body[key]);
    }
    res.json({ settings: await setSettings(patch) });
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
