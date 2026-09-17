/**
 * ¿Está el crawler haciendo su trabajo?
 *
 * Esta pregunta tiene DOS respuestas distintas según dónde corra el sistema, y
 * confundirlas es lo que hacía que el panel de producción dijera "El crawler
 * no responde" mientras el crawler funcionaba perfectamente:
 *
 *   - En local hay un proceso residente (`npm run crawler`, o el scheduler
 *     embebido del servidor) que late cada `scheduler_tick` segundos. Ahí
 *     "vivo" significa "ha latido hace poco", y noventa segundos de silencio
 *     son motivo de alarma de verdad.
 *
 *   - En producción NO hay proceso: hay un cron de Netlify que dispara dos
 *     veces al día y la función muere en cuanto termina. Entre una pasada y
 *     la siguiente no late nada, ni debe. Medir eso con la ventana de noventa
 *     segundos daba "detenido" 22 de las 24 horas: el latido sólo está fresco
 *     durante los cuatro minutos que dura cada pasada, o sea el 0,6 % del día.
 *
 * Así que aquí se miran las dos cosas. Un latido reciente prueba que hay un
 * proceso vivo ahora mismo; y, si no lo hay, lo que prueba que el sistema
 * funciona es que la última pasada esté dentro del plazo que marca su propio
 * horario. Sólo cuando NINGUNA de las dos se cumple el crawler está parado de
 * verdad - y entonces el panel tiene que decirlo sin adornos.
 */

/** Dos horas de cortesía: un cron puede retrasarse, pero no medio día. */
const GRACE_MS = 2 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * El hueco más largo que el horario deja sin una pasada.
 *
 * Con [5, 21] son dieciséis horas (de las 21:00 a las 05:00 del día
 * siguiente), no ocho: lo que importa para decidir si algo va mal es el peor
 * caso, no el mejor.
 */
export function longestGapMs(hours) {
  const sorted = [...new Set(hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort(
    (a, b) => a - b,
  );
  if (!sorted.length) return DAY_MS;
  if (sorted.length === 1) return DAY_MS;

  let longest = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const next = sorted[(i + 1) % sorted.length];
    const gap = i === sorted.length - 1 ? next + 24 - sorted[i] : next - sorted[i];
    longest = Math.max(longest, gap);
  }
  return longest * HOUR_MS;
}

/** La próxima vez que el cron va a disparar, en UTC. */
export function nextRunAt(hours, now = new Date()) {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  if (!sorted.length) return null;

  const at = (dayOffset, hour) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + dayOffset);
    date.setUTCHours(hour, 0, 0, 0);
    return date;
  };

  for (const hour of sorted) {
    const candidate = at(0, hour);
    if (candidate.getTime() > now.getTime()) return candidate.toISOString();
  }
  return at(1, sorted[0]).toISOString();
}

/**
 * El estado del crawler, dicho como es.
 *
 * @returns {{
 *   state: 'running'|'idle'|'paused'|'stalled'|'never',
 *   alive: boolean, beating: boolean, onSchedule: boolean,
 *   last_run_at: string|null, next_run_at: string|null,
 *   overdue_by_ms: number|null, expected_gap_ms: number,
 * }}
 */
export function crawlerHealth({
  state = {},
  now = new Date(),
  scheduleUtc = [5, 21],
  tickSeconds = 15,
} = {}) {
  const at = now.getTime();
  const heartbeat = state.last_heartbeat_at ? new Date(state.last_heartbeat_at).getTime() : 0;
  const lastRun = state.last_run_at ? new Date(state.last_run_at).getTime() : 0;

  // La ventana corta: sólo dice algo cuando hay un proceso residente latiendo.
  const staleAfterMs = Math.max(90_000, tickSeconds * 3000);
  const beating = heartbeat > 0 && at - heartbeat < staleAfterMs;

  // La ventana larga: el plazo que marca el propio horario del cron.
  const expectedGapMs = longestGapMs(scheduleUtc);
  const deadline = expectedGapMs + GRACE_MS;
  const sinceRun = lastRun ? at - lastRun : null;
  const onSchedule = lastRun > 0 && sinceRun < deadline;

  const alive = state.status !== 'paused' && (beating || onSchedule);

  // Un crawler apagado a mano no es un crawler roto, y el panel no debe
  // dar la alarma por algo que alguien decidió. Pero tampoco está vigilando,
  // así que no se cuenta como vivo.
  const kind = state.status === 'paused'
    ? 'paused'
    : !lastRun && !beating
      ? 'never'
      : state.status === 'running' && beating
        ? 'running'
        : alive
          ? 'idle'
          : 'stalled';

  return {
    state: kind,
    alive,
    beating,
    onSchedule,
    last_run_at: state.last_run_at ?? null,
    next_run_at: nextRunAt(scheduleUtc, now),
    // Cuánto lleva de retraso sobre su propio plazo. Null mientras va al día:
    // es el número que convierte "parece parado" en "lleva X sin ejecutarse".
    overdue_by_ms: kind === 'stalled' && sinceRun !== null ? sinceRun - deadline : null,
    expected_gap_ms: expectedGapMs,
  };
}
