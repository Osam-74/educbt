import assert from 'node:assert/strict';
import { termDatesProblem } from './term-dates';
import type { Term } from './engine';

let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log(`PASS  ${name}`); }
const terms: Term[] = [
  { id: 1, title: 'First Term', position: 1, startsOn: '2026-09-07', endsOn: '2026-12-18' },
  { id: 2, title: 'Second Term', position: 2, startsOn: '2027-01-11', endsOn: '2027-04-02' },
  { id: 3, title: 'Third Term', position: 3, startsOn: null, endsOn: null },
];
const session: { startsOn: string | null; endsOn: string | null } = { startsOn: '2026-09-01', endsOn: '2027-07-31' };
const p = (termId: number, startsOn: string, endsOn: string, s = session) => termDatesProblem({ termId, startsOn, endsOn }, terms, s);

check('ordinary new dates are accepted', () => assert.equal(p(1, '2026-09-14', '2026-12-11'), null));
check('a term that has no dates yet can be given some', () => assert.equal(p(3, '2027-04-26', '2027-07-23'), null));
check('both dates are required', () => { assert.match(p(1, '', '2026-12-11')!, /both/); assert.match(p(1, '2026-09-14', '')!, /both/); });
check('the closing date cannot be before the resumption date, but the same day is allowed', () => {
  assert.match(p(1, '2026-12-11', '2026-09-14')!, /cannot be before/); assert.equal(p(1, '2026-10-01', '2026-10-01'), null);
});
check('junk and impossible dates are refused', () => { assert.match(p(1, '2026-02-30', '2026-12-11')!, /real calendar/); assert.match(p(1, 'soon', 'later')!, /real calendar/); });
check('a term cannot overlap another, by one day or by being inside it', () => {
  assert.match(p(1, '2026-09-14', '2027-01-11')!, /overlap Second Term/); assert.match(p(2, '2026-12-18', '2027-04-02')!, /overlap First Term/);
  assert.match(p(3, '2026-10-01', '2026-10-05')!, /overlap First Term/);
});
check('a term next to another (the day after it closes) is fine', () => assert.equal(p(2, '2026-12-19', '2027-04-02'), null));
check('a term may keep its own dates, and widen or shrink them, without clashing with itself', () => {
  assert.equal(p(1, '2026-09-07', '2026-12-18'), null); assert.equal(p(1, '2026-09-01', '2027-01-10'), null);
});
check('dates must fall within the session', () => {
  assert.match(p(1, '2026-08-20', '2026-12-18')!, /within the session/); assert.match(p(2, '2027-01-11', '2027-08-15')!, /within the session/);
  assert.equal(p(1, '2026-08-20', '2026-12-18', { startsOn: null, endsOn: null }), null);
});
check('an unknown term is refused', () => assert.match(p(99, '2026-09-14', '2026-12-11')!, /not found/));
console.log(`\n${count} checks passed.`);
