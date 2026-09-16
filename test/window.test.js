import assert from 'node:assert/strict';
import test from 'node:test';
import { dateOf, dayWindow, localParts, previousDate, reportDue } from '../src/monitor/window.js';

const MADRID = 'Europe/Madrid';

test('the local date is the reader\'s date, not the server\'s', () => {
  // 23:30 UTC on 15 September is already the 16th in Madrid (UTC+2).
  assert.equal(localParts(MADRID, new Date('2026-09-15T23:30:00Z')).date, '2026-09-16');
  assert.equal(localParts('UTC', new Date('2026-09-15T23:30:00Z')).date, '2026-09-15');
});

test('previousDate is yesterday where the reader lives', () => {
  // 06:00 Madrid on the 16th: the report covers the 15th.
  assert.equal(previousDate(MADRID, new Date('2026-09-16T04:00:00Z')), '2026-09-15');
  // 00:30 Madrid on the 16th (22:30 UTC on the 15th): still the 15th to cover.
  assert.equal(previousDate(MADRID, new Date('2026-09-15T22:30:00Z')), '2026-09-15');
});

test('a day window is exactly 24 hours of local time', () => {
  const summer = dayWindow('2026-09-15', MADRID);
  assert.equal(summer.start, '2026-09-14T22:00:00.000Z'); // CEST, UTC+2
  assert.equal(summer.end, '2026-09-15T21:59:59.999Z');

  const winter = dayWindow('2026-01-15', MADRID);
  assert.equal(winter.start, '2026-01-14T23:00:00.000Z'); // CET, UTC+1
  assert.equal(winter.end, '2026-01-15T22:59:59.999Z');
});

test('the window survives the daylight-saving change', () => {
  // The night the clocks go back: the local day is 25 hours long.
  const dst = dayWindow('2026-10-25', MADRID);
  const hours = (new Date(dst.end).getTime() - new Date(dst.start).getTime() + 1) / 3_600_000;
  assert.equal(hours, 25);
});

test('dateOf maps an instant back to the local day that contains it', () => {
  const window = dayWindow('2026-09-15', MADRID);
  assert.equal(dateOf(window.start, MADRID), '2026-09-15');
  assert.equal(dateOf(window.end, MADRID), '2026-09-15');
  // One millisecond either side belongs to the neighbouring day.
  assert.equal(dateOf(new Date(Date.parse(window.start) - 1).toISOString(), MADRID), '2026-09-14');
  assert.equal(dateOf(new Date(Date.parse(window.end) + 1).toISOString(), MADRID), '2026-09-16');
});

test('the report waits for its hour and then goes out once', () => {
  const at = (iso) => new Date(iso);
  // 05:00 Madrid, report hour 7: too early.
  assert.equal(
    reportDue({ timeZone: MADRID, hour: 7, lastSentDate: null, now: at('2026-09-16T03:00:00Z') }),
    false,
  );
  // 08:00 Madrid: due.
  assert.equal(
    reportDue({ timeZone: MADRID, hour: 7, lastSentDate: null, now: at('2026-09-16T06:00:00Z') }),
    true,
  );
  // Already sent today: not due again, however many times we are asked.
  assert.equal(
    reportDue({ timeZone: MADRID, hour: 7, lastSentDate: '2026-09-16', now: at('2026-09-16T06:00:00Z') }),
    false,
  );
  // Yesterday's send does not satisfy today.
  assert.equal(
    reportDue({ timeZone: MADRID, hour: 7, lastSentDate: '2026-09-15', now: at('2026-09-16T06:00:00Z') }),
    true,
  );
});
