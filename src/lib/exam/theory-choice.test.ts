import assert from 'node:assert/strict';
import { normaliseAnswerCount, answerCountProblem, compulsoryNotice, perStudent, drawTheory, dealtTheory, type TheoryRow } from './theory-choice';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log('PASS  ' + name); }
// Seeded and repeatable. A small seed gives near-zero first values, so it is warmed up before use.
const rnd = (seed: number) => { let x = seed * 2654435761 % 2147483647 || 1; const next = () => { x = (x * 16807) % 2147483647; return (x - 1) / 2147483646; }; for (let i = 0; i < 8; i++) next(); return next; };
const rows = (n: number, must: number[] = []): TheoryRow[] => Array.from({ length: n }, (_, i) => ({ id: 100 + i, isCompulsory: must.includes(100 + i) }));

check('a blank, negative or nonsense number means "every student answers all" (0)', () => {
  for (const v of ['', '  ', '-3', 'abc', '2.5', null, undefined, NaN, -1, 0, '0', 2.5]) assert.equal(normaliseAnswerCount(v), 0, String(v));
});
check('a real number is kept, trimmed, and capped at 1000', () => {
  assert.equal(normaliseAnswerCount('3'), 3); assert.equal(normaliseAnswerCount(' 12 '), 12);
  assert.equal(normaliseAnswerCount(7), 7); assert.equal(normaliseAnswerCount('99999'), 1000);
});
check('no limit is placed on how many theory questions a teacher may write', () => {
  // The old rule stopped a teacher at the school quota. Now only "students answer more than were written" is refused.
  assert.equal(answerCountProblem(0, 0), ''); assert.equal(answerCountProblem(5, 40), ''); assert.equal(answerCountProblem(5, 5), '');
});
check('asking students to answer more than the teacher wrote is refused, in plain words', () => {
  const p = answerCountProblem(5, 3);
  assert.match(p, /answers 5 theory questions, but only 3 are written/); assert.match(answerCountProblem(2, 1), /but only 1 is written/);
  assert.match(answerCountProblem(1, 0), /answers 1 theory question, but only 0 are written/);
});
check('more ticks than answers is a notice, never a refusal, and it says what will happen', () => {
  assert.equal(compulsoryNotice(3, 2), ''); assert.equal(compulsoryNotice(3, 3), ''); assert.equal(compulsoryNotice(0, 9), '');
  assert.match(compulsoryNotice(2, 4), /4 questions are ticked compulsory but each student answers 2.*so they will answer 4/);
});
check('per-student count: 0 or too-large means all; compulsory above the number wins', () => {
  assert.equal(perStudent(0, 7, 2), 7); assert.equal(perStudent(7, 7, 0), 7); assert.equal(perStudent(9, 7, 0), 7);
  assert.equal(perStudent(3, 7, 1), 3); assert.equal(perStudent(2, 7, 4), 4); assert.equal(perStudent(2, 3, 9), 3);
});
check('number 0 gives every student every question, in the order written', () => {
  assert.deepEqual(drawTheory(rows(5), 0, rnd(1)), [100, 101, 102, 103, 104]);
});
check('every student gets exactly the chosen number, in authored order, no repeats', () => {
  for (let s = 1; s <= 60; s++) {
    const got = drawTheory(rows(7), 3, rnd(s));
    assert.equal(got.length, 3); assert.equal(new Set(got).size, 3);
    assert.deepEqual(got, [...got].sort((a, b) => a - b), 'authored order kept');
  }
});
check('compulsory questions are in every student\'s paper, whatever the draw', () => {
  for (let s = 1; s <= 80; s++) {
    const got = drawTheory(rows(7, [101, 105]), 3, rnd(s));
    assert.ok(got.includes(101) && got.includes(105), 'both compulsory present'); assert.equal(got.length, 3);
  }
});
check('the rest is genuinely random: different students get different non-compulsory questions', () => {
  const seen = new Set<string>();
  for (let s = 1; s <= 60; s++) seen.add(drawTheory(rows(7, [100]), 3, rnd(s)).join(','));
  assert.ok(seen.size > 5, `only ${seen.size} different papers in 60 students`);
});
check('every non-compulsory question can come up, and about equally often (none is starved)', () => {
  const tally = new Map<number, number>();
  for (let s = 1; s <= 600; s++) drawTheory(rows(6, [100]), 2, rnd(s)).forEach((id) => tally.set(id, (tally.get(id) ?? 0) + 1));
  assert.deepEqual([...tally.keys()].sort(), [100, 101, 102, 103, 104, 105]);
  for (const id of [101, 102, 103, 104, 105]) assert.ok((tally.get(id) ?? 0) > 60 && (tally.get(id) ?? 0) < 180, `question ${id} came up ${tally.get(id)} times of 600 (expect ~120)`);
});
check('more compulsory than the number: every student gets all the compulsory ones and nothing else', () => {
  for (let s = 1; s <= 30; s++) assert.deepEqual(drawTheory(rows(6, [100, 102, 104]), 2, rnd(s)), [100, 102, 104]);
});
check('a number larger than what was written just gives everything', () => {
  assert.deepEqual(drawTheory(rows(3), 9, rnd(4)), [100, 101, 102]); assert.deepEqual(drawTheory([], 3, rnd(4)), []);
});
check('the draw never changes the rows it was given', () => {
  const r = rows(5, [101]); const copy = JSON.stringify(r); drawTheory(r, 2, rnd(2)); assert.equal(JSON.stringify(r), copy);
});
check('a student is judged only on the theory questions they were dealt', () => {
  const theory = new Set([100, 101, 102, 103]);
  assert.deepEqual(dealtTheory([1, 2, 3, 101, 103], theory), [101, 103]); assert.deepEqual(dealtTheory([1, 2], theory), []);
});
console.log(`\ntheory-choice rules: ${passed} passed, 0 failed`);
