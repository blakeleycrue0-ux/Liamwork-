import { Router } from 'express';
import { digestStatus, sendDigest } from '../../notifications/digest.js';
import { pendingForDigest } from '../../db/repositories/posts.repo.js';
import { summariseDigest } from '../../notifications/digest.ai.js';
import { getAllSettings } from '../../db/repositories/settings.repo.js';
import { asyncHandler } from '../middleware/errors.js';

export const digestRoutes = Router();

digestRoutes.get(
  '/',
  asyncHandler(async (req, res) => res.json({ digest: await digestStatus() })),
);

/** Manual send, for "quiero verlo ahora" - does not wait for the hour. */
digestRoutes.post(
  '/run',
  asyncHandler(async (req, res) => res.json(await sendDigest({ force: true }))),
);

/** Same summary, rendered in the dashboard without sending any email. */
digestRoutes.get(
  '/preview',
  asyncHandler(async (req, res) => {
    const settings = await getAllSettings();
    const posts = await pendingForDigest();
    const summary = await summariseDigest(posts, {
      timeZone: settings.digest_timezone,
      date: new Date().toISOString().slice(0, 10),
    });
    res.json({ summary, items: posts.length });
  }),
);
