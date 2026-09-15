import { Router } from 'express';
import {
  createWorker,
  deleteWorker,
  getWorker,
  listWorkers,
  setActive,
  updateWorker,
} from '../../db/repositories/workers.repo.js';
import { sendTestEmail } from '../../notifications/notifier.js';
import { asyncHandler } from '../middleware/errors.js';
import { parseWorkerPayload, ValidationError } from '../validate.js';

export const workerRoutes = Router();

workerRoutes.get('/', (req, res) => res.json({ workers: listWorkers() }));

workerRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parseWorkerPayload(req.body ?? {});
    res.status(201).json({ worker: createWorker(data) });
  }),
);

workerRoutes.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = parseWorkerPayload(req.body ?? {}, { partial: true });
    const worker = updateWorker(Number(req.params.id), data);
    if (!worker) return res.status(404).json({ error: 'Trabajador no encontrado' });
    return res.json({ worker });
  }),
);

workerRoutes.delete('/:id', (req, res) => {
  const removed = deleteWorker(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Trabajador no encontrado' });
  return res.json({ ok: true });
});

workerRoutes.post('/:id/toggle', (req, res) => {
  const current = getWorker(Number(req.params.id));
  if (!current) return res.status(404).json({ error: 'Trabajador no encontrado' });
  const next = req.body?.active === undefined ? !current.active : Boolean(req.body.active);
  return res.json({ worker: setActive(current.id, next) });
});

/** Test email: to one worker, or to every active worker when no id is given. */
workerRoutes.post(
  '/test-email',
  asyncHandler(async (req, res) => {
    const result = await sendTestEmail();
    res.json({ ok: true, ...result });
  }),
);

workerRoutes.post(
  '/:id/test-email',
  asyncHandler(async (req, res) => {
    const worker = getWorker(Number(req.params.id));
    if (!worker) return res.status(404).json({ error: 'Trabajador no encontrado' });
    const result = await sendTestEmail(worker.email);
    return res.json({ ok: true, ...result });
  }),
);

workerRoutes.use((error, req, res, next) => {
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
  return next(error);
});
