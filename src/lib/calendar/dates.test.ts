import assert from 'node:assert/strict';
import { localToInstant, toLocalDate, toLocalTime } from './dates';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log('PASS  ' + name); };

check('Lagos 09:00 is 08:00 UTC (Lagos is UTC+1 all year)', () => assert.equal(localToInstant('2026-11-21T09:00', 'Africa/Lagos')!.toISOString(), '2026-11-21T08:00:00.000Z'));
check('Lagos midnight is 23:00 UTC the day before', () => assert.equal(localToInstant('2026-11-21T00:00', 'Africa/Lagos')!.toISOString(), '2026-11-20T23:00:00.000Z'));
check('UTC is itself', () => assert.equal(localToInstant('2026-11-21T09:00', 'UTC')!.toISOString(), '2026-11-21T09:00:00.000Z'));
check('a zone ahead of Lagos (Nairobi, UTC+3) and one behind (New York in winter, UTC-5)', () => {
  assert.equal(localToInstant('2026-11-21T09:00', 'Africa/Nairobi')!.toISOString(), '2026-11-21T06:00:00.000Z');
  assert.equal(localToInstant('2026-12-21T09:00', 'America/New_York')!.toISOString(), '2026-12-21T14:00:00.000Z');
});
check('daylight saving is honoured: New York in summer is UTC-4', () => assert.equal(localToInstant('2026-07-21T09:00', 'America/New_York')!.toISOString(), '2026-07-21T13:00:00.000Z'));
check('shortly after the clocks go back (New York, 1 Nov 2026 03:00 is standard time, UTC-5)', () => assert.equal(localToInstant('2026-11-01T03:00', 'America/New_York')!.toISOString(), '2026-11-01T08:00:00.000Z'));
check('shortly before the clocks go forward (New York, 8 Mar 2026 01:30 is still UTC-5)', () => assert.equal(localToInstant('2026-03-08T01:30', 'America/New_York')!.toISOString(), '2026-03-08T06:30:00.000Z'));
check('the morning after the clocks go forward is UTC-4', () => assert.equal(localToInstant('2026-03-08T09:00', 'America/New_York')!.toISOString(), '2026-03-08T13:00:00.000Z'));
check('a zone with a half-hour offset (India, UTC+5:30)', () => assert.equal(localToInstant('2026-11-21T09:00', 'Asia/Kolkata')!.toISOString(), '2026-11-21T03:30:00.000Z'));
check('it round-trips: the instant shows the same local date and time back in that zone', () => {
  const i = localToInstant('2026-11-21T22:45', 'Africa/Lagos')!;
  assert.equal(toLocalDate(i, 'Africa/Lagos'), '2026-11-21'); assert.equal(toLocalTime(i, 'Africa/Lagos'), '22:45');
});
check('a space instead of T is accepted (some browsers send it)', () => assert.equal(localToInstant('2026-11-21 09:00', 'Africa/Lagos')!.toISOString(), '2026-11-21T08:00:00.000Z'));
check('things that are not a date and time give null, not a wrong date', () => {
  for (const bad of ['', 'tomorrow', '2026-02-31T09:00', '2026-13-01T09:00', '2026-11-21T25:00', '2026-11-21T09:60', '2026-11-21', '21/11/2026 09:00'])
    assert.equal(localToInstant(bad, 'Africa/Lagos'), null, JSON.stringify(bad));
});
check('29 February exists in a leap year and not otherwise', () => {
  assert.ok(localToInstant('2028-02-29T10:00', 'Africa/Lagos')); assert.equal(localToInstant('2026-02-29T10:00', 'Africa/Lagos'), null);
});
console.log(`${n} date helper checks passed`);
