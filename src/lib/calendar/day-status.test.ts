/**
 * The default status of a date and the effect of breaks (WordPress plugin parity): school day / weekend / none from the
 * term dates alone, a break or non-instructional day taking a school day off, and the "restore default" rule (cancel the
 * entry). Pure rules, no database.
 */
import assert from 'node:assert/strict';
import * as D from './dates';
import { NON_INSTRUCTIONAL, defaultStatus, dayStatus, instructionalDays, conflictsFor, type CalEvent, type Term } from './engine';

let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log(`PASS  ${name}`); }
const ev = (o: Partial<CalEvent> & { startsOn: string; endsOn?: string }): CalEvent => ({
  key: 'e1', id: 1, source: 'event', title: 'T', category: 'school_event', status: 'scheduled',
  endsOn: o.startsOn, startTime: null, endTime: null, allDay: true, venue: '', description: '', audience: 'everyone',
  classIds: [], published: true, repeat: 'none', repeatEvery: 1, repeatUntil: null, ...o,
});
// First term: Monday 7 Sep 2026 to Friday 18 Dec 2026. Second term starts Monday 11 Jan 2027.
const terms: Term[] = [
  { id: 1, title: 'First', position: 1, startsOn: '2026-09-07', endsOn: '2026-12-18' },
  { id: 2, title: 'Second', position: 2, startsOn: '2027-01-11', endsOn: '2027-04-02' },
];

// Fixture dates are checked in code: a wrong weekday here would make every other check meaningless.
check('fixture weekdays are what the tests assume', () => {
  assert.equal(D.weekday('2026-09-07'), 1); assert.equal(D.weekday('2026-09-12'), 6); assert.equal(D.weekday('2026-09-13'), 0);
  assert.equal(D.weekday('2026-12-18'), 5); assert.equal(D.weekday('2027-01-11'), 1);
});
check('Monday to Friday inside a term is a school day', () => {
  for (const d of ['2026-09-07', '2026-09-11', '2026-10-14', '2026-12-18']) assert.equal(defaultStatus(d, terms), 'school_day', d);
});
check('Saturday and Sunday inside a term are a weekend', () => {
  for (const d of ['2026-09-12', '2026-09-13', '2026-11-28']) assert.equal(defaultStatus(d, terms), 'weekend', d);
});
check('a date outside every term has NO default, whatever day of the week', () => {
  for (const d of ['2026-09-04', '2026-09-05', '2026-12-21', '2026-12-26', '2027-01-08']) assert.equal(defaultStatus(d, terms), 'none', d);
});
check('the first and last day of a term belong to the term', () => {
  assert.equal(defaultStatus('2026-09-07', terms), 'school_day'); assert.equal(defaultStatus('2026-12-18', terms), 'school_day');
  assert.equal(defaultStatus('2026-09-06', terms), 'none'); assert.equal(defaultStatus('2026-12-19', terms), 'none'); // Saturday AFTER the term closes: outside it, so no default
});
check('a term with no dates yet gives every date no default', () => {
  assert.equal(defaultStatus('2026-10-14', [{ id: 1, title: 'T', position: 1, startsOn: null, endsOn: null }]), 'none');
  assert.equal(defaultStatus('2026-10-14', []), 'none');
});
check('changing a term\'s dates changes the default of every day at once (nothing is stored)', () => {
  const moved: Term[] = [{ ...terms[0]!, startsOn: '2026-09-14' }, terms[1]!];
  assert.equal(defaultStatus('2026-09-08', terms), 'school_day'); assert.equal(defaultStatus('2026-09-08', moved), 'none');
});

check('all four kinds of day off take a school day off', () => {
  assert.deepEqual([...NON_INSTRUCTIONAL].sort(), ['mid_term_break', 'non_instructional', 'public_holiday', 'school_holiday']);
  for (const category of NON_INSTRUCTIONAL) {
    const s = dayStatus('2026-10-14', terms, [ev({ category, startsOn: '2026-10-14' })]);
    assert.equal(s.state, 'off', category); assert.equal(s.default, 'school_day'); assert.equal(s.by?.category, category);
  }
});
check('a mid-term break removes its days from the instructional count', () => {
  const brk = ev({ category: 'mid_term_break', startsOn: '2026-10-26', endsOn: '2026-10-30' });
  assert.equal(instructionalDays(terms, [brk]).size, instructionalDays(terms, []).size - 5);
  assert.equal(instructionalDays(terms, [ev({ category: 'non_instructional', startsOn: '2026-10-14' })]).size, instructionalDays(terms, []).size - 1);
});
check('a SPECIAL event (school_event, exam, deadline...) does not shade a date', () => {
  for (const category of ['school_event', 'academic', 'examination', 'administrative', 'deadline', 'ceremonial'] as const)
    assert.equal(dayStatus('2026-10-14', terms, [ev({ category, startsOn: '2026-10-14' })]).state, 'school_day', category);
});
check('restore default: a CANCELLED entry no longer shades its date, and a draft-free scheduled one does', () => {
  const e = ev({ category: 'mid_term_break', startsOn: '2026-10-14' });
  assert.equal(dayStatus('2026-10-14', terms, [e]).state, 'off');
  assert.equal(dayStatus('2026-10-14', terms, [{ ...e, status: 'cancelled' }]).state, 'school_day');
});
check('a holiday on a weekend or outside any term changes nothing', () => {
  assert.equal(dayStatus('2026-09-12', terms, [ev({ category: 'public_holiday', startsOn: '2026-09-12' })]).state, 'weekend');
  assert.equal(dayStatus('2026-12-23', terms, [ev({ category: 'school_holiday', startsOn: '2026-12-23' })]).state, 'none');
});
check('only the dates inside a multi-day break are off', () => {
  const brk = ev({ category: 'mid_term_break', startsOn: '2026-10-26', endsOn: '2026-10-28' });
  assert.deepEqual(['2026-10-23', '2026-10-26', '2026-10-28', '2026-10-29'].map((d) => dayStatus(d, terms, [brk]).state), ['school_day', 'off', 'off', 'school_day']);
});
check('an examination planned on a mid-term break or a non-instructional day is warned about, like a holiday', () => {
  const ctx = (others: CalEvent[]) => ({ terms, others, sessionStart: '2026-09-07', sessionEnd: '2027-04-02' });
  for (const category of ['public_holiday', 'school_holiday', 'mid_term_break', 'non_instructional'] as const) {
    const exam = ev({ key: 'x', category: 'examination', startsOn: '2026-10-27' });
    const out = conflictsFor(exam, ctx([ev({ key: 'h', id: 2, category, title: 'Off', startsOn: '2026-10-26', endsOn: '2026-10-30' })]));
    assert.ok(out.some((c) => c.kind === 'exam_in_holiday'), category);
  }
});

check('against a plain reference over 2000 seeded random dates and break sets', () => {
  let s = 99; const r = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  for (let i = 0; i < 2000; i++) {
    const date = D.addDays('2026-08-01', r(300));
    const evs = Array.from({ length: r(4) }, (_, k) => { const a = D.addDays('2026-08-01', r(300)); return ev({ key: `h${k}`, id: k, category: NON_INSTRUCTIONAL[r(4)]!, startsOn: a, endsOn: D.addDays(a, r(6)), status: r(5) === 0 ? 'cancelled' : 'scheduled' }); });
    const inTerm = terms.some((t) => date >= t.startsOn! && date <= t.endsOn!);
    const dow = D.weekday(date);
    const covered = evs.some((e) => e.status !== 'cancelled' && date >= e.startsOn && date <= e.endsOn);
    const expected = !inTerm ? 'none' : dow === 0 || dow === 6 ? 'weekend' : covered ? 'off' : 'school_day';
    assert.equal(dayStatus(date, terms, evs).state, expected, date);
    // and it agrees with the day count the progress bar uses
    assert.equal(instructionalDays(terms, evs).has(date), expected === 'school_day', date);
  }
});
console.log(`\n${count} checks passed.`);
