/**
 * Pure tests for the calendar's date maths and rules. No database.
 *   npx tsx src/lib/calendar/calendar.test.ts
 */
import assert from 'node:assert/strict';
import * as D from './dates';
import {
  occurrences, buildPeriods, stateOf, instructionalDays, progress, nextResumption, daysToNextExam, conflictsFor,
  type CalEvent, type Term,
} from './engine';

let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log(`PASS  ${name}`); }

const ev = (o: Partial<CalEvent> & { startsOn: string; endsOn?: string }): CalEvent => ({
  key: 'e1', id: 1, source: 'event', title: 'T', category: 'school_event', status: 'scheduled',
  endsOn: o.startsOn, startTime: null, endTime: null, allDay: true, venue: '', description: '', audience: 'everyone',
  classIds: [], published: true, repeat: 'none', repeatEvery: 1, repeatUntil: null, ...o,
});
const term = (id: number, title: string, s: string, e: string, position = id): Term => ({ id, title, position, startsOn: s, endsOn: e });

// ── dates
check('real calendar dates only: 31 Feb, 29 Feb in a common year and junk are refused', () => {
  assert.ok(D.isDateStr('2028-02-29')); assert.ok(!D.isDateStr('2027-02-29')); assert.ok(!D.isDateStr('2026-02-31'));
  assert.ok(!D.isDateStr('2026-2-3')); assert.ok(!D.isDateStr('')); assert.ok(!D.isDateStr(null)); assert.ok(!D.isDateStr('2026-13-01'));
});
check('adding days crosses month, year and leap-day boundaries', () => {
  assert.equal(D.addDays('2026-12-31', 1), '2027-01-01'); assert.equal(D.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(D.addDays('2027-02-28', 1), '2027-03-01'); assert.equal(D.addDays('2026-03-01', -1), '2026-02-28');
});
check('adding months clamps to the month end and never spills over', () => {
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28'); assert.equal(D.addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(D.addMonths('2026-03-31', 1), '2026-04-30'); assert.equal(D.addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(D.addMonths('2026-01-15', -2), '2025-11-15');
});
check('weekday, weekend and the Monday of a week', () => {
  assert.equal(D.weekday('2026-11-19'), 4); assert.ok(D.isWeekend('2026-11-21')); assert.ok(D.isWeekend('2026-11-22')); assert.ok(!D.isWeekend('2026-11-23'));
  assert.equal(D.startOfWeek('2026-11-22'), '2026-11-16'); assert.equal(D.startOfWeek('2026-11-16'), '2026-11-16'); assert.equal(D.startOfWeek('2026-11-19'), '2026-11-16');
});
check('a day count agrees with a brute-force walk over 2000 random pairs', () => {
  let s = 11; const r = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  for (let i = 0; i < 2000; i++) { const a = D.addDays('2020-01-01', r(3000)); const n = r(400); assert.equal(D.diffDays(a, D.addDays(a, n)), n); assert.equal(D.eachDay(a, D.addDays(a, n)).length, n + 1); }
});
check('a huge range is refused instead of hanging the page', () => { assert.throws(() => D.eachDay('2000-01-01', '2100-01-01')); });
check('an instant belongs to the SCHOOL\'s day: 23:30 in Lagos is 22:30 UTC the same day, 00:30 Lagos is the day before in UTC', () => {
  assert.equal(D.toLocalDate(new Date('2026-11-19T22:30:00Z'), 'Africa/Lagos'), '2026-11-19');
  assert.equal(D.toLocalDate(new Date('2026-11-19T23:30:00Z'), 'Africa/Lagos'), '2026-11-20');
  assert.equal(D.toLocalDate(new Date('2026-11-19T23:30:00Z'), 'UTC'), '2026-11-19');
  assert.equal(D.toLocalTime(new Date('2026-11-19T07:05:00Z'), 'Africa/Lagos'), '08:05');
  assert.ok(D.isValidTimeZone('Africa/Lagos')); assert.ok(!D.isValidTimeZone('Mars/Olympus'));
});

// ── occurrences
check('a one-off event is returned only when it touches the window', () => {
  const e = ev({ startsOn: '2026-10-05', endsOn: '2026-10-07' });
  assert.equal(occurrences(e, '2026-10-01', '2026-10-31').length, 1); assert.equal(occurrences(e, '2026-10-07', '2026-10-09').length, 1);
  assert.equal(occurrences(e, '2026-10-08', '2026-10-31').length, 0); assert.equal(occurrences(e, '2026-09-01', '2026-10-04').length, 0);
});
check('weekly every 2 weeks gives every second Monday, ends on the end date, and keeps a 3-day length', () => {
  const e = ev({ startsOn: '2026-09-07', endsOn: '2026-09-09', repeat: 'weekly', repeatEvery: 2, repeatUntil: '2026-10-31' });
  const o = occurrences(e, '2026-09-01', '2026-12-31');
  assert.deepEqual(o.map((x) => x.startsOn), ['2026-09-07', '2026-09-21', '2026-10-05', '2026-10-19']);
  assert.ok(o.every((x) => D.diffDays(x.startsOn, x.endsOn) === 2)); assert.equal(new Set(o.map((x) => x.key)).size, o.length);
});
check('monthly on the 31st lands on each month\'s last day, never skips a month', () => {
  const e = ev({ startsOn: '2026-01-31', repeat: 'monthly', repeatUntil: '2026-06-30' });
  assert.deepEqual(occurrences(e, '2026-01-01', '2026-12-31').map((x) => x.startsOn), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
});
check('yearly on 29 Feb is kept on the 28th in common years', () => {
  const e = ev({ startsOn: '2028-02-29', repeat: 'yearly', repeatUntil: '2031-12-31' });
  assert.deepEqual(occurrences(e, '2028-01-01', '2031-12-31').map((x) => x.startsOn), ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28']);
});
check('a repeat with no end stops at the window, and a daily one cannot run away', () => {
  const o = occurrences(ev({ startsOn: '2026-01-01', repeat: 'daily' }), '2026-01-01', '2026-01-10'); assert.equal(o.length, 10);
  assert.ok(occurrences(ev({ startsOn: '2000-01-01', repeat: 'daily' }), '2000-01-01', '2099-12-31').length <= 800);
});
check('an occurrence that began before the window but runs into it is still shown', () => {
  const e = ev({ startsOn: '2026-09-28', endsOn: '2026-10-02', repeat: 'monthly', repeatUntil: '2026-12-31' });
  assert.equal(occurrences(e, '2026-10-01', '2026-10-01').length, 1);
});
check('expansion agrees with a brute-force day walk over 300 random weekly and daily rules', () => {
  let s = 5; const r = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  for (let i = 0; i < 300; i++) {
    const start = D.addDays('2026-01-01', r(200)); const span = r(4); const every = 1 + r(3); const kind = r(2) ? 'weekly' : 'daily'; const until = D.addDays(start, 20 + r(100));
    const e = ev({ startsOn: start, endsOn: D.addDays(start, span), repeat: kind, repeatEvery: every, repeatUntil: until });
    const from = D.addDays(start, r(30)), to = D.addDays(from, r(60));
    const step = kind === 'weekly' ? 7 * every : every; const want: string[] = [];
    for (let k = 0; ; k++) { const st = D.addDays(start, k * step); if (st > until) break; if (D.overlaps(st, D.addDays(st, span), from, to)) want.push(st); }
    assert.deepEqual(occurrences(e, from, to).map((x) => x.startsOn), want);
  }
});

// ── periods
const T1 = term(1, 'First Term', '2026-09-14', '2026-12-11'), T2 = term(2, 'Second Term', '2027-01-11', '2027-04-02'), T3 = term(3, 'Third Term', '2027-04-26', '2027-07-23');
check('periods run in order with a vacation between terms and none where terms touch', () => {
  const p = buildPeriods([T3, T1, T2], []); assert.deepEqual(p.map((x) => x.kind), ['term', 'vacation', 'term', 'vacation', 'term']);
  assert.equal(p[1]!.startsOn, '2026-12-12'); assert.equal(p[1]!.endsOn, '2027-01-10');
  assert.equal(buildPeriods([term(1, 'A', '2026-01-01', '2026-03-31'), term(2, 'B', '2026-04-01', '2026-06-30')], []).filter((x) => x.kind === 'vacation').length, 0);
});
check('a term with no dates set is left out, not guessed', () => {
  assert.equal(buildPeriods([{ id: 9, title: 'X', position: 1, startsOn: null, endsOn: null }], []).length, 0);
});
check('completed, ongoing and upcoming are decided by today, inclusive of the first and last day', () => {
  assert.equal(stateOf('2026-09-14', '2026-12-11', '2026-09-13'), 'upcoming'); assert.equal(stateOf('2026-09-14', '2026-12-11', '2026-09-14'), 'ongoing');
  assert.equal(stateOf('2026-09-14', '2026-12-11', '2026-12-11'), 'ongoing'); assert.equal(stateOf('2026-09-14', '2026-12-11', '2026-12-12'), 'completed');
});

// ── instructional days and weeks
check('instructional days exclude weekends: a plain 2-week term has 10', () => {
  const t = [term(1, 'T', '2026-09-14', '2026-09-27')]; assert.equal(instructionalDays(t, []).size, 10);
});
check('a holiday inside a term removes its weekdays only; one outside a term changes nothing; a cancelled one removes nothing', () => {
  const t = [term(1, 'T', '2026-09-14', '2026-09-27')];
  assert.equal(instructionalDays(t, [ev({ category: 'public_holiday', startsOn: '2026-09-16' })]).size, 9);
  assert.equal(instructionalDays(t, [ev({ category: 'school_holiday', startsOn: '2026-09-19', endsOn: '2026-09-22' })]).size, 8);
  assert.equal(instructionalDays(t, [ev({ category: 'school_holiday', startsOn: '2026-11-01', endsOn: '2026-11-05' })]).size, 10);
  assert.equal(instructionalDays(t, [ev({ category: 'public_holiday', startsOn: '2026-09-16', status: 'cancelled' })]).size, 10);
  assert.equal(instructionalDays(t, [ev({ category: 'school_event', startsOn: '2026-09-16' })]).size, 10);
});
check('progress: counts, current week, percent; holidays shorten the term and a week with no school day is not counted', () => {
  const t = [term(1, 'T', '2026-09-14', '2026-10-09')];
  const p = progress(t, [], '2026-09-23'); assert.equal(p.totalDays, 20); assert.equal(p.doneDays, 7); assert.equal(p.remainingDays, 13);
  assert.equal(p.totalWeeks, 4); assert.equal(p.doneWeeks, 1); assert.equal(p.remainingWeeks, 3); assert.equal(p.currentWeek, 2); assert.equal(p.percent, 35);
  const brk = ev({ category: 'school_holiday', startsOn: '2026-09-21', endsOn: '2026-09-25' });
  const q = progress(t, [brk], '2026-09-30'); assert.equal(q.totalWeeks, 3); assert.equal(q.totalDays, 15);
  assert.equal(q.currentWeek, 2, 'the break week is skipped: 14 Sep is week 1, the week of 28 Sep is week 2');
});
check('before, between and after terms: week is 0, nothing negative, percent bounded', () => {
  const t = [T1, T2, T3];
  const a = progress(t, [], '2026-08-01'); assert.equal(a.currentWeek, 0); assert.equal(a.doneDays, 0); assert.equal(a.percent, 0);
  const b = progress(t, [], '2026-12-25'); assert.equal(b.currentWeek, 0); assert.ok(b.doneDays > 0 && b.remainingDays > 0);
  const c = progress(t, [], '2027-09-01'); assert.equal(c.remainingDays, 0); assert.equal(c.percent, 100); assert.equal(c.remainingWeeks, 0);
});
check('progress agrees with a brute-force count over 200 random terms, holidays and days', () => {
  let s = 3; const r = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  for (let i = 0; i < 200; i++) {
    const a = D.addDays('2026-01-01', r(300)), b = D.addDays(a, 20 + r(90)); const t = [term(1, 'T', a, b)];
    const hs = Array.from({ length: r(4) }, (_, k) => { const x = D.addDays(a, r(100)); return ev({ key: `h${k}`, category: 'school_holiday', startsOn: x, endsOn: D.addDays(x, r(8)) }); });
    const today = D.addDays(a, r(140) - 20);
    const ref = D.eachDay(a, b).filter((d) => !D.isWeekend(d) && !hs.some((h) => d >= h.startsOn && d <= h.endsOn));
    const p = progress(t, hs, today);
    assert.equal(p.totalDays, ref.length); assert.equal(p.doneDays, ref.filter((d) => d < today).length);
    assert.equal(p.totalWeeks, new Set(ref.map(D.startOfWeek)).size);
    assert.ok(p.percent >= 0 && p.percent <= 100 && p.remainingDays >= 0 && p.remainingWeeks >= 0);
  }
});
check('next resumption is the first term starting after today; none when there is none', () => {
  assert.deepEqual(nextResumption([T1, T2, T3], '2026-12-20'), { title: 'Second Term', on: '2027-01-11', inDays: 22 });
  assert.equal(nextResumption([T1, T2, T3], '2027-08-01'), null); assert.equal(nextResumption([T1], '2026-09-14'), null);
});
check('days to the next exam: counts from today, 0 while one is running, ignores cancelled and finished ones', () => {
  const ex = (k: string, s: string, e: string, st: CalEvent['status'] = 'scheduled') => ev({ key: k, category: 'examination', startsOn: s, endsOn: e, status: st, title: k });
  assert.deepEqual(daysToNextExam([ex('a', '2026-12-01', '2026-12-05')], '2026-11-19'), { title: 'a', on: '2026-12-01', inDays: 12 });
  assert.equal(daysToNextExam([ex('a', '2026-11-16', '2026-11-20')], '2026-11-19')!.inDays, 0);
  assert.equal(daysToNextExam([ex('a', '2026-11-01', '2026-11-05')], '2026-11-19'), null);
  assert.equal(daysToNextExam([ex('a', '2026-12-01', '2026-12-05', 'cancelled')], '2026-11-19'), null);
});

// ── conflicts
const ctx = (others: CalEvent[], terms = [T1, T2, T3]) => ({ terms, others, sessionStart: '2026-09-14', sessionEnd: '2027-07-23' });
check('an exam on a school holiday and an exam outside every term are both warned', () => {
  const hol = ev({ key: 'h', category: 'school_holiday', title: 'Mid-term break', startsOn: '2026-10-26', endsOn: '2026-10-30' });
  const x = ev({ key: 'x', category: 'examination', startsOn: '2026-10-27', title: 'Maths' });
  assert.deepEqual(conflictsFor(x, ctx([hol, x])).map((c) => c.kind), ['exam_in_holiday']);
  const y = ev({ key: 'y', category: 'examination', startsOn: '2026-12-20', title: 'Late' });
  assert.ok(conflictsFor(y, ctx([y])).some((c) => c.kind === 'exam_outside_term'));
});
check('a normal exam in term time has no warning, and a cancelled or draft event is never warned', () => {
  const x = ev({ key: 'x', category: 'examination', startsOn: '2026-11-17' }); assert.equal(conflictsFor(x, ctx([x])).length, 0);
  const hol = ev({ key: 'h', category: 'school_holiday', startsOn: '2026-11-16', endsOn: '2026-11-20' });
  assert.equal(conflictsFor({ ...x, status: 'cancelled' }, ctx([hol])).length, 0); assert.equal(conflictsFor({ ...x, status: 'draft' }, ctx([hol])).length, 0);
  const cancelledHol = { ...hol, status: 'cancelled' as const }; assert.equal(conflictsFor(x, ctx([cancelledHol])).length, 0);
});
check('an event outside the whole session is warned', () => {
  assert.ok(conflictsFor(ev({ key: 'z', startsOn: '2027-09-01' }), ctx([])).some((c) => c.kind === 'event_outside_session'));
});
check('major events overlapping are warned; different times the same day are not; minor ones are never', () => {
  const a = ev({ key: 'a', category: 'ceremonial', title: 'Graduation', startsOn: '2026-11-20', allDay: false, startTime: '10:00', endTime: '12:00' });
  const b = ev({ key: 'b', category: 'school_event', title: 'Sports', startsOn: '2026-11-20', allDay: false, startTime: '11:00', endTime: '13:00' });
  assert.deepEqual(conflictsFor(a, ctx([a, b])).map((c) => c.kind), ['overlap_major']);
  const c = { ...b, startTime: '12:00', endTime: '14:00' }; assert.equal(conflictsFor(a, ctx([a, c])).length, 0);
  const d = { ...b, allDay: true, startTime: null, endTime: null }; assert.equal(conflictsFor(a, ctx([a, d])).length, 1);
  const m = ev({ key: 'm', category: 'administrative', startsOn: '2026-11-20' }); assert.equal(conflictsFor(a, ctx([a, m])).length, 0);
});
check('two exams on one day for different classes are fine; for the same class, or the whole school, they clash', () => {
  const x = (k: string, cls: number[]) => ev({ key: k, category: 'examination', title: k, startsOn: '2026-11-17', classIds: cls });
  assert.equal(conflictsFor(x('a', [1]), ctx([x('a', [1]), x('b', [2])])).length, 0);
  assert.equal(conflictsFor(x('a', [1]), ctx([x('a', [1]), x('b', [1, 2])])).length, 1);
  assert.equal(conflictsFor(x('a', []), ctx([x('a', []), x('b', [2])])).length, 1);
});

console.log(`\n${count} checks passed.`);
