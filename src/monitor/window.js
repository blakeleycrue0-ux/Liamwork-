/**
 * The day a report covers.
 *
 * Requirement, stated plainly: the morning summary covers 00:00:00 to
 * 23:59:59 of the PREVIOUS day, in the reader's own timezone. Everything
 * here exists so that "yesterday" means yesterday in Madrid, not yesterday
 * in UTC on a server in Ohio - the two disagree for two hours every night,
 * which is exactly when the report is generated.
 */

/** Calendar date and clock hour at a given instant, where the reader lives. */
export function localParts(timeZone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** The offset that timeZone is from UTC at this instant, in minutes. */
function offsetMinutes(timeZone, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '00' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - date.getTime()) / 60_000;
}

/** The previous calendar day in `timeZone`, as YYYY-MM-DD. */
export function previousDate(timeZone, now = new Date()) {
  const today = localParts(timeZone, now).date;
  const [year, month, day] = today.split('-').map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  return previous.toISOString().slice(0, 10);
}

/**
 * The UTC instant of a given wall-clock time in `timeZone`.
 *
 * Refined twice on purpose. A single guess uses the offset in force at the
 * wrong moment, and on the two nights a year when the clocks move that is
 * off by an hour - which would silently shift the report window.
 */
function zonedToUtc(year, month, day, hour, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = wall - offsetMinutes(timeZone, new Date(wall)) * 60_000;
  const second = wall - offsetMinutes(timeZone, new Date(first)) * 60_000;
  return new Date(second);
}

/**
 * The exact UTC instants that bound a local calendar day.
 *
 * The day the clocks go back is 25 hours long and the day they go forward is
 * 23; both are handled, because the start and the end are resolved
 * independently rather than by adding 24 hours to the start.
 */
export function dayWindow(date, timeZone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const start = zonedToUtc(year, month, day, 0, timeZone);
  const end = new Date(zonedToUtc(year, month, day + 1, 0, timeZone).getTime() - 1);
  return { date: String(date), start: start.toISOString(), end: end.toISOString(), timeZone };
}

/** Which local calendar day a UTC instant belongs to. */
export const dateOf = (isoInstant, timeZone) => localParts(timeZone, new Date(isoInstant)).date;

/** True once the configured hour has passed today, where the reader lives. */
export function reportDue({ timeZone, hour, lastSentDate, now = new Date() }) {
  const { date, hour: localHour } = localParts(timeZone, now);
  if (localHour < Number(hour)) return false;
  return lastSentDate !== date;
}
