import { Router } from 'express';
import { config } from '../../config/index.js';
import { countsByStatus, listWebsites } from '../../db/repositories/websites.repo.js';
import { countWorkers } from '../../db/repositories/workers.repo.js';
import { listChanges, usageSince } from '../../db/repositories/changes.repo.js';
import { countErrorsSince, lastCheckedAt, listLogs } from '../../db/repositories/checkLogs.repo.js';
import { getState } from '../../db/repositories/crawlerState.repo.js';
import { getInt } from '../../db/repositories/settings.repo.js';
import { runPipeline } from '../../monitor/index.js';
import { crawlerHealth } from '../../monitor/health.js';
import { reportStatus } from '../../monitor/report.js';
import { asyncHandler } from '../middleware/errors.js';

export const statusRoutes = Router();

/** Everything the dashboard "Resumen" needs, in a single poll. */
statusRoutes.get(
  '/',
  asyncHandler(async (req, res) => {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [state, websites, workers, checkedAt, errors24h, recentChanges, recentErrors, tick, report, usage7d] =
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
      // Ni transporte ni remitente: el panel sólo necesita saber si el correo
      // está configurado. El resto describe la instalación.
      mail: { configured: config.mail.transport === 'smtp' },
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

    const outcome = await runPipeline();
    res.json({
      ok: true,
      mode: 'inline',
      websites: outcome.crawl.websites,
      pagesChanged: outcome.crawl.pagesChanged,
      analyzed: outcome.analysis.analyzed,
      reported: outcome.analysis.reported,
      failed: outcome.crawl.failed,
      errors: outcome.analysis.errors,
    });
  }),
);

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
