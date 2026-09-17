import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * El panel de producción decía "El crawler no responde" mientras el crawler
 * funcionaba a la perfección.
 *
 * Los datos reales del 17 de septiembre de 2026: el cron disparó a las
 * 05:00:42 UTC, recorrió las veintisiete webs entre las 05:00:50 y las
 * 05:01:33, analizó hasta las 05:04:35 y terminó dejando status='idle' y una
 * duración de 233.430 ms. Todo correcto. Seis horas después el panel lo daba
 * por muerto, porque medía la vida con una ventana de noventa segundos - la
 * de un proceso residente que en serverless no existe.
 *
 * Estas pruebas fijan las dos mitades: que un cron al día se cuenta como vivo,
 * y que uno que se salta su turno se cuenta como parado.
 */

const { crawlerHealth, longestGapMs, nextRunAt } = await import('../src/monitor/health.js');

const PRODUCCION = {
  status: 'idle',
  last_run_at: '2026-09-17T05:00:42.425Z',
  last_heartbeat_at: '2026-09-17T05:04:35.856Z',
  last_run_duration_ms: 233430,
};
const HORARIO = [5, 21];

/* ============ 1) EL CASO REAL ========================================== */

test('seis horas después de una pasada correcta, el crawler está vivo', () => {
  // El instante exacto en que se miró el panel de producción.
  const health = crawlerHealth({
    state: PRODUCCION,
    now: new Date('2026-09-17T11:23:19Z'),
    scheduleUtc: HORARIO,
  });

  assert.equal(health.alive, true, 'seis horas entre dos pasadas es lo normal, no un fallo');
  assert.equal(health.state, 'idle');
  assert.equal(health.beating, false, 'y sin embargo no hay ningún proceso latiendo');
  assert.equal(health.onSchedule, true, 'lo que prueba que va bien es que la pasada está al día');
  assert.equal(health.overdue_by_ms, null, 'no lleva retraso');
  assert.equal(health.next_run_at, '2026-09-17T21:00:00.000Z', 'y dice cuándo vuelve a mirar');
});

test('justo antes de la siguiente pasada sigue estando vivo', () => {
  const health = crawlerHealth({
    state: PRODUCCION,
    now: new Date('2026-09-17T20:59:00Z'),
    scheduleUtc: HORARIO,
  });
  assert.equal(health.alive, true, 'quince horas y media todavía caben en el horario');
  assert.equal(health.state, 'idle');
});

/* ============ 2) Y CUANDO DE VERDAD SE PARA ============================ */

test('si se salta una pasada entera, el panel lo dice', () => {
  // Última pasada a las 05:00 y ya son las 06:00 del día siguiente: se saltó
  // la de las 21:00 Y la de las 05:00. Eso sí es un crawler parado.
  const health = crawlerHealth({
    state: PRODUCCION,
    now: new Date('2026-09-18T06:00:00Z'),
    scheduleUtc: HORARIO,
  });

  assert.equal(health.alive, false, 'no se disimula');
  assert.equal(health.state, 'stalled');
  assert.ok(health.overdue_by_ms > 0, 'y se puede decir cuánto lleva de retraso');
});

test('el plazo es el hueco MÁS LARGO del horario, no el más corto', () => {
  // De las 21:00 a las 05:00 van dieciséis horas. Medir con las ocho del otro
  // hueco daría por muerto al crawler cada noche, puntualmente.
  assert.equal(longestGapMs([5, 21]) / 3600000, 16);
  assert.equal(longestGapMs([0, 6, 12, 18]) / 3600000, 6);
  assert.equal(longestGapMs([7]) / 3600000, 24, 'una sola pasada al día: el hueco es el día');
  assert.equal(longestGapMs([]) / 3600000, 24, 'sin horario, se supone lo peor');
});

test('nunca ha corrido: ni vivo ni parado, sin estrenar', () => {
  const health = crawlerHealth({ state: {}, now: new Date(), scheduleUtc: HORARIO });
  assert.equal(health.state, 'never');
  assert.equal(health.alive, false);
});

test('apagado a mano no es lo mismo que roto', () => {
  const health = crawlerHealth({
    state: { ...PRODUCCION, status: 'paused' },
    now: new Date('2026-09-17T11:23:19Z'),
    scheduleUtc: HORARIO,
  });
  assert.equal(health.state, 'paused', 'se dice que está en pausa');
  assert.equal(health.alive, false, 'y que no está vigilando');
  assert.equal(health.overdue_by_ms, null, 'pero sin dar la alarma: fue una decisión');
});

/* ============ 3) EL PROCESO RESIDENTE SIGUE MIDIÉNDOSE IGUAL =========== */

test('en local, un latido reciente basta aunque no haya habido pasada', () => {
  const now = new Date('2026-09-17T11:23:19Z');
  const health = crawlerHealth({
    state: { status: 'running', last_run_at: null, last_heartbeat_at: new Date(now.getTime() - 5000).toISOString() },
    now,
    scheduleUtc: HORARIO,
  });
  assert.equal(health.beating, true);
  assert.equal(health.alive, true);
  assert.equal(health.state, 'running', 'y se ve que está comprobando ahora mismo');
});

test('un proceso residente que deja de latir se nota en noventa segundos', () => {
  const now = new Date('2026-09-17T11:23:19Z');
  const health = crawlerHealth({
    state: { status: 'running', last_run_at: null, last_heartbeat_at: new Date(now.getTime() - 120_000).toISOString() },
    now,
    scheduleUtc: HORARIO,
  });
  assert.equal(health.beating, false);
  assert.equal(health.alive, false, 'sin pasadas y sin latido, no hay nada vivo');
});

/* ============ 4) LA PRÓXIMA PASADA ===================================== */

test('la próxima pasada sale del horario, no de una columna vacía', () => {
  const dentroDelDia = nextRunAt(HORARIO, new Date('2026-09-17T11:00:00Z'));
  assert.equal(dentroDelDia, '2026-09-17T21:00:00.000Z');

  const pasadaLaUltima = nextRunAt(HORARIO, new Date('2026-09-17T22:30:00Z'));
  assert.equal(pasadaLaUltima, '2026-09-18T05:00:00.000Z', 'salta al día siguiente');
});

/* ============ 5) EL HORARIO DE CONFIG Y EL DEL CRON, EL MISMO ========== */

test('el horario configurado coincide con el cron que despliega Netlify', async () => {
  // Netlify exige que `schedule` sea un literal, así que el horario está en
  // dos sitios por fuerza. Esta prueba es lo que impide que se separen.
  const fs = await import('node:fs');
  const fuente = fs.readFileSync(new URL('../netlify/functions/crawl-scheduled.mts', import.meta.url), 'utf8');
  const cron = fuente.match(/schedule:\s*'([^']+)'/)?.[1];
  assert.ok(cron, 'la función programada declara su cron');

  const [minuto, horas] = cron.split(' ');
  assert.equal(minuto, '0', 'a la hora en punto');

  const { config } = await import('../src/config/index.js');
  assert.deepEqual(
    horas.split(',').map(Number).sort((a, b) => a - b),
    [...config.crawler.scheduleUtc].sort((a, b) => a - b),
    'el cron y la configuración dicen las mismas horas',
  );
});

/* ============ 6) LA REVISIÓN MANUAL EN SERVERLESS ====================== */

test('en el despliegue, "Comprobar ahora" se entrega a la función de fondo', async () => {
  // Esta función tiene diez segundos y una pasada real tarda 233. Ejecutarla
  // aquí dentro era un tiempo de espera agotado garantizado: el botón del
  // panel no ha funcionado nunca en producción.
  const fuente = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/api/routes/status.routes.js', import.meta.url), 'utf8'),
  );
  const bloque = fuente.slice(fuente.indexOf("'/run-now'"), fuente.indexOf("'/websites-health'"));

  assert.match(bloque, /process\.env\.URL \|\| process\.env\.DEPLOY_PRIME_URL/, 'mira si está desplegado');
  assert.match(bloque, /crawl-background/, 'y le entrega el trabajo a quien tiene quince minutos');
  assert.match(bloque, /mode: 'background'/, 'diciéndolo, para que el panel no finja que ya terminó');
  assert.match(bloque, /runPipeline\(\)/, 'en local sigue ejecutándose en línea');
});
