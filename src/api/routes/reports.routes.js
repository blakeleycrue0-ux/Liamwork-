import { Router } from 'express';
import { asyncHandler } from '../middleware/errors.js';
import { buildReport, reportStatus, sendDailyReport } from '../../monitor/report.js';
import { buildReportEmail } from '../../monitor/report.email.js';
import { runPipeline } from '../../monitor/index.js';
import { getReport, listReports } from '../../db/repositories/reports.repo.js';
import { getChange, listChanges, usageSince } from '../../db/repositories/changes.repo.js';
import { listPages, listVersions, getVersion } from '../../db/repositories/pages.repo.js';
import { getAllSettings } from '../../db/repositories/settings.repo.js';
import { previousDate } from '../../monitor/window.js';

export const reportRoutes = Router();

/** When the next report goes out and what is waiting for it. */
reportRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({
      status: await reportStatus(),
      reports: await listReports(30),
      usage_7d: await usageSince(new Date(Date.now() - 7 * 86_400_000).toISOString()),
    });
  }),
);

/**
 * Builds a report without sending it, so the exact JSON and the exact email
 * can be inspected before anyone's inbox is involved.
 */
reportRoutes.get(
  '/preview',
  asyncHandler(async (req, res) => {
    const settings = await getAllSettings();
    const zone = settings.digest_timezone || 'Europe/Madrid';
    const date = req.query.date || previousDate(zone);
    const report = await buildReport({ date, timeZone: zone });
    res.json({ report: report.payload, email: buildReportEmail(report, { timeZone: zone }) });
  }),
);

/** Runs the whole pipeline now: crawl, analyse, and store. No email. */
reportRoutes.post(
  '/crawl',
  asyncHandler(async (req, res) => {
    const outcome = await runPipeline({
      limitWebsites: Number(req.body?.limit) || 0,
      maxPages: Number(req.body?.max_pages) || undefined,
    });
    res.json({
      ok: true,
      crawl: outcome.crawl,
      analysis: outcome.analysis,
      dates: outcome.dates,
      duration_ms: outcome.durationMs,
      results: outcome.results.map((result) => ({
        website: result.name,
        ok: result.ok,
        pages_seen: result.pagesSeen ?? 0,
        pages_changed: result.pagesChanged ?? 0,
        pages_failed: result.pagesFailed ?? 0,
        baseline: Boolean(result.baseline),
        error: result.error ?? null,
      })),
    });
  }),
);

/** Sends a report now, for the given date or yesterday. */
reportRoutes.post(
  '/send',
  asyncHandler(async (req, res) => {
    const outcome = await sendDailyReport({ date: req.body?.date, force: true });
    res.json(outcome);
  }),
);

reportRoutes.get(
  '/changes',
  asyncHandler(async (req, res) => {
    res.json({
      changes: await listChanges({
        websiteId: req.query.website_id ? Number(req.query.website_id) : null,
        date: req.query.date || null,
        limit: Math.min(Number(req.query.limit) || 100, 500),
        offset: Number(req.query.offset) || 0,
      }),
    });
  }),
);

/** The audit trail for one verdict: what Claude read, and what it answered. */
reportRoutes.get(
  '/changes/:id',
  asyncHandler(async (req, res) => {
    const change = await getChange(Number(req.params.id));
    if (!change) return res.status(404).json({ error: 'Cambio no encontrado' });

    const [before, after] = await Promise.all([
      change.from_version_id ? getVersion(change.from_version_id) : null,
      change.to_version_id ? getVersion(change.to_version_id) : null,
    ]);

    return res.json({
      change,
      audit: {
        model: change.model,
        analyzer: change.analyzer,
        detected_at: change.detected_at,
        input_tokens: change.input_tokens,
        output_tokens: change.output_tokens,
        cached_tokens: change.cached_tokens,
        input: change.analysis_input,
        output: safeJson(change.analysis_output),
      },
      versions: {
        before: before && { id: before.id, captured_at: before.captured_at, text: before.text },
        after: after && { id: after.id, captured_at: after.captured_at, text: after.text },
      },
    });
  }),
);

reportRoutes.get(
  '/pages',
  asyncHandler(async (req, res) => {
    res.json({
      pages: await listPages({
        websiteId: req.query.website_id ? Number(req.query.website_id) : null,
        limit: Math.min(Number(req.query.limit) || 100, 500),
        offset: Number(req.query.offset) || 0,
      }),
    });
  }),
);

reportRoutes.get(
  '/pages/:id/versions',
  asyncHandler(async (req, res) => {
    res.json({ versions: await listVersions(Number(req.params.id), 30) });
  }),
);

reportRoutes.get(
  '/:date',
  asyncHandler(async (req, res) => {
    const report = await getReport(req.params.date);
    if (!report) return res.status(404).json({ error: 'No hay informe para esa fecha' });
    return res.json({ report });
  }),
);

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
