import { Router } from 'express';
import { config } from '../../config/index.js';
import { countsByStatus, listWebsites } from '../../db/repositories/websites.repo.js';
import { countWorkers } from '../../db/repositories/workers.repo.js';
import { changesForRun, listChanges, usageSince } from '../../db/repositories/changes.repo.js';
import { expireStaleRuns, getRun, latestRun, listRuns } from '../../db/repositories/runs.repo.js';
import { countErrorsSince, lastCheckedAt, listLogs } from '../../db/repositories/checkLogs.repo.js';
import { getState } from '../../db/repositories/crawlerState.repo.js';
import { getInt } from '../../db/repositories/settings.repo.js';
import { runPipeline } from '../../monitor/index.js';
import { crawlerHealth } from '../../monitor/health.js';
import { reportStatus } from '../../monitor/report.js';
import { slackConfigured } from '../../notifications/slack.js';
import { asyncHandler } from '../middleware/errors.js';

export const statusRoutes = Router();

/**
 * Una ejecución, tal y como la ve el panel.
 *
 * Aquí se decide qué NO sale: slack_error puede contener el texto que devolvió
 * Slack, así que se publica sólo si hubo fallo y ya viene saneado desde
 * src/notifications/slack.js. El webhook no está en ninguna de estas columnas
 * y no puede llegar aquí.
 */
const summarise = (run) => ({
  id: run.id,
  started_at: run.started_at,
  finished_at: run.finished_at,
  status: run.status,
  origin: run.origin,
  duration_ms: run.duration_ms,
  websites: run.websites,
  pages_seen: run.pages_seen,
  pages_changed: run.pages_changed,
  relevant: run.relevant,
  ignored: run.ignored,
  drafts: run.drafts,
  websites_failed: run.websites_failed,
  errors: run.errors,
  slack: { sent: run.slack_sent, error: run.slack_error ?? null },
});

/** Everything the dashboard "Resumen" needs, in a single poll. */
statusRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Una pasada que murió sin poder cerrarse -se agotó el tiempo, el
    // contenedor se recicló- dejaría al panel girando una rueda para siempre.
    await expireStaleRuns().catch(() => {});

    const [state, websites, workers, checkedAt, errors24h, recentChanges, recentErrors, tick, report, usage7d, run] =
      await Promise.all([
        getState(),
        countsByStatus(),
        countWorkers(),
        lastCheckedAt(),
        countErrorsSince(since24h),
        listChanges({ limit: 8 }),
        listLogs({ onlyErrors: true, limit: 1 }),
        getInt('scheduler_tick', 15),
        reportStatus(),
        usageSince(since7d),
        latestRun(),
      ]);

    const reportable = recentChanges.filter((change) => ['NEW', 'UPDATED'].includes(change.change_type));

    // Vivo NO es "ha latido hace noventa segundos". En producción no hay un
    // proceso latiendo: hay un cron que dispara dos veces al día y la función
    // muere al acabar. Ver src/monitor/health.js.
    const health = crawlerHealth({
      state,
      scheduleUtc: config.crawler.scheduleUtc,
      tickSeconds: tick,
    });

    res.json({
      crawler: {
        status: health.state,
        alive: health.alive,
        last_run_at: state.last_run_at,
        // La próxima la marca el horario del cron, no una columna que en
        // serverless nadie rellena nunca.
        next_run_at: health.next_run_at,
        last_run_duration_ms: state.last_run_duration_ms,
        overdue_by_ms: health.overdue_by_ms,
        expected_gap_ms: health.expected_gap_ms,
      },
      websites,
      workers,
      checks: { last_checked_at: checkedAt, errors_24h: errors24h },
      report,
      // El recuento de análisis sí es información de producto ("cuánto ha
      // trabajado el sistema"); los tokens y el modelo son de infraestructura
      // y se quedan en /api/diagnostics.
      usage_7d: { analyses: usage7d.analyses },
      recent_changes: reportable,
      // La última comprobación, para que el panel sepa si hay una en curso
      // sin tener que preguntar por separado en cada sondeo.
      last_run: run && summarise(run),
      // Ni transporte ni remitente: el panel sólo necesita saber si el correo
      // está configurado. El resto describe la instalación.
      mail: { configured: config.mail.transport === 'smtp' },
      // Sólo si hay canal, NUNCA cuál. El webhook no sale del servidor.
      slack: { configured: slackConfigured() },
      brand: { name: config.brand.name, credit: config.brand.credit, owner: config.brand.owner },
      server_time: new Date().toISOString(),
    });
  }),
);

/**
 * "Revisa todo ahora mismo". No envía ningún correo.
 *
 * En serverless NO se puede hacer aquí dentro: esta función tiene diez
 * segundos y una pasada real tarda casi cuatro minutos -233 segundos, medidos
 * en producción-. Ejecutarla en línea garantizaba un tiempo de espera agotado,
 * así que el botón del panel no ha funcionado nunca en el despliegue.
 *
 * Se hace lo mismo que el cron: entregar el trabajo a la función de fondo, que
 * tiene quince minutos, y contestar al instante. En local no hay a quién
 * entregárselo ni prisa por contestar, así que se ejecuta y se devuelve el
 * recuento completo.
 */
statusRoutes.post(
  '/run-now',
  asyncHandler(async (req, res) => {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL;

    if (base) {
      const response = await fetch(`${base}/.netlify/functions/crawl-background`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ origin: 'manual' }),
      });
      if (!response.ok) {
        return res.status(502).json({
          ok: false,
          error: `No se pudo lanzar la revisión (${response.status})`,
        });
      }
      return res.json({
        ok: true,
        mode: 'background',
        started_at: new Date().toISOString(),
        message: 'Revisión lanzada. Tarda unos minutos en recorrer las webs.',
      });
    }

    const outcome = await runPipeline({ origin: 'manual' });
    res.json({
      ok: true,
      mode: 'inline',
      run_id: outcome.runId,
      websites: outcome.crawl.websites,
      pagesChanged: outcome.crawl.pagesChanged,
      analyzed: outcome.analysis.analyzed,
      reported: outcome.analysis.reported,
      failed: outcome.crawl.failed,
      errors: outcome.analysis.errors,
    });
  }),
);

/** Las últimas comprobaciones, para el historial del panel. */
statusRoutes.get(
  '/runs',
  asyncHandler(async (req, res) => {
    await expireStaleRuns().catch(() => {});
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 50);
    const runs = await listRuns(limit);
    res.json({ runs: runs.map(summarise) });
  }),
);

/**
 * Lo que encontró UNA comprobación concreta.
 *
 * Los relevantes vienen enteros, con su categoría y su borrador. Los
 * ignorados NO: sólo su recuento y lo justo para poder desplegarlos si
 * alguien quiere mirar. Es la diferencia entre un panel que informa y uno que
 * vuelca ciento cuarenta y tres filas encima del que lo abre.
 */
statusRoutes.get(
  '/runs/:id',
  asyncHandler(async (req, res) => {
    const run = await getRun(Number.parseInt(req.params.id, 10));
    if (!run) return res.status(404).json({ error: 'Esa comprobación no existe' });

    const [relevant, ignored] = await Promise.all([
      changesForRun(run.id, { types: ['NEW', 'UPDATED'] }),
      changesForRun(run.id, { types: ['IGNORED', 'UNCHANGED'] }),
    ]);

    res.json({
      run: summarise(run),
      relevant: relevant.map(publicChange),
      ignored_count: ignored.length,
      ignored: ignored.map((change) => ({
        id: change.id,
        website_name: change.website_name,
        title: change.title,
        url: change.url,
        detected_at: change.detected_at,
        // Por qué se descartó, en la frase que escribió el análisis. Sin
        // tokens, sin modelo, sin nada de infraestructura.
        reasoning: change.reasoning,
      })),
    });
  }),
);

/** Un cambio relevante, con todo lo que se pidió enseñar y nada más. */
const publicChange = (change) => ({
  id: change.id,
  website_id: change.website_id,
  website_name: change.website_name,
  category: change.category,
  change_type: change.change_type,
  priority: change.priority,
  title: change.title,
  summary: change.summary,
  what_changed: change.what_changed,
  previous_value: change.previous_value,
  new_value: change.new_value,
  detected_at: change.detected_at,
  url: change.url || change.website_url,
  draft_message: change.draft_message,
  // Si este cambio ya salió por Slack. La hora, no el canal.
  slack_notified_at: change.slack_notified_at,
});

statusRoutes.get(
  '/websites-health',
  asyncHandler(async (req, res) => {
    const websites = await listWebsites();
    res.json({
      websites: websites.map((website) => ({
        id: website.id,
        name: website.name,
        active: website.active,
        last_checked_at: website.last_checked_at,
        consecutive_errors: website.consecutive_errors,
      })),
    });
  }),
);
