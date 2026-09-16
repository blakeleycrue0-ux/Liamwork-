import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { buildReport, reportStatus, sendDailyReport } from '../../monitor/report.js';
import { getAllSettings } from '../../db/repositories/settings.repo.js';
import { previousDate } from '../../monitor/window.js';

/**
 * Kept as an alias of /api/reports.
 *
 * The daily email used to be called the "digest" and these paths are what the
 * dashboard and old bookmarks call. They now answer for the new pipeline, so
 * nothing points at the retired one.
 */
export const digestRoutes = Router();

digestRoutes.get(
  '/',
  asyncHandler(async (req, res) => res.json({ digest: await reportStatus() })),
);

/** Manual send: "quiero verlo ahora", without waiting for the hour. */
digestRoutes.post(
  '/run',
  asyncHandler(async (req, res) => res.json(await sendDailyReport({ force: true }))),
);

/** The same report rendered for the dashboard, with no email sent. */
digestRoutes.get(
  '/preview',
  asyncHandler(async (req, res) => {
    const settings = await getAllSettings();
    const zone = settings.digest_timezone || 'Europe/Madrid';
    const date = req.query.date || previousDate(zone);
    const report = await buildReport({ date, timeZone: zone });
    res.json({ report: report.payload, items: report.total_changes, date });
  }),
);
