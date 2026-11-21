import assert from 'node:assert/strict';
import { candidateOrder, paperWorth, theoryIdsInOrder, paperIsOnPaper, setFlag, typedAnswerRefused, type PaperPoolRow } from './theory-delivery';

let passed = 0;
function check(name: string, fn: () => void) { fn(); passed++; console.log('PASS  ' + name); }
const q = (id: number, type: string, sequence = id, passageId: number | null = null, passagePosition = 0): PaperPoolRow => ({ id, type, sequence, passageId, passagePosition });
const objective = (n: number, from = 1) => Array.from({ length: n }, (_, i) => q(from + i, 'single_choice'));
const rnd = (seed: number) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

check('a paper with no theory is delivered exactly as before: the drawn objective questions, nothing else', () => {
  const order = candidateOrder(objective(10), 4, false);
  assert.deepEqual(order, [1, 2, 3, 4]);
});
check('theory comes after the objective part, every time, even when objective questions are shuffled', () => {
  const pool = [q(100, 'theory'), ...objective(10), q(101, 'theory')];
  for (let s = 1; s <= 25; s++) {
    const order = candidateOrder(pool, 5, true, rnd(s));
    assert.equal(order.length, 7); assert.deepEqual(order.slice(5), [100, 101]);
    assert.ok(order.slice(0, 5).every((id) => id <= 10));
  }
});
check('EVERY theory question reaches EVERY candidate (not a draw)', () => {
  const pool = [...objective(8), q(50, 'theory'), q(51, 'theory'), q(52, 'theory'), q(53, 'theory')];
  for (let s = 1; s <= 25; s++) assert.deepEqual(candidateOrder(pool, 3, true, rnd(s)).slice(3).sort(), [50, 51, 52, 53]);
});
check('theory keeps the order the setter wrote it in, whatever order the database returned it', () => {
  const pool = [q(52, 'theory', 3), q(50, 'theory', 1), q(51, 'theory', 2), ...objective(3)];
  assert.deepEqual(candidateOrder(pool, 3, false).slice(3), [50, 51, 52]);
});
check('the objective count is NOT reduced by theory: 20 asked for with 4 theory is 20 + 4, not 16 + 4', () => {
  const order = candidateOrder([...objective(30), ...[900, 901, 902, 903].map((id) => q(id, 'theory'))], 20, true, rnd(7));
  assert.equal(order.length, 24); assert.equal(order.filter((id) => id < 900).length, 20);
});
check('a bank thinner than the target gives the whole objective pool plus all theory', () => {
  assert.equal(candidateOrder([...objective(3), q(90, 'theory')], 10, true, rnd(3)).length, 4);
});
check('a paper that is ALL theory is delivered (an objective target of 0 means no objective draw is lost)', () => {
  assert.deepEqual(candidateOrder([q(1, 'theory'), q(2, 'theory')], 0, true), [1, 2]);
});
check('whole passages still travel together in the objective part', () => {
  const pool = [q(1, 'single_choice', 1, 7, 1), q(2, 'single_choice', 2, 7, 2), q(3, 'single_choice', 3, 7, 3), ...objective(4, 10), q(99, 'theory')];
  for (let s = 1; s <= 25; s++) {
    const order = candidateOrder(pool, 5, true, rnd(s)); const inPassage = order.filter((id) => id <= 3);
    assert.ok(inPassage.length === 0 || (inPassage.length === 3 && inPassage.join() === '1,2,3'), order.join());
    assert.equal(order[order.length - 1], 99);
  }
});
check('theory ids are found in an attempt order', () => {
  const types = new Map<number, string>([[1, 'single_choice'], [2, 'theory'], [3, 'single_choice'], [4, 'theory']]);
  assert.deepEqual(theoryIdsInOrder([1, 3, 2, 4], types), [2, 4]); assert.deepEqual(theoryIdsInOrder([1, 3], types), []);
});
check('paper worth: objective is the drawn share, theory is all of it', () => {
  const w = paperWorth([...objective(10).map(() => ({ type: 'single_choice', marks: 2 })), { type: 'theory', marks: 5 }, { type: 'theory', marks: 10 }], 4);
  assert.deepEqual(w, { objective: 8, theory: 15, theoryCount: 2 });
});
check('a paper is on paper only when it has theory and EVERY theory set is flagged', () => {
  assert.equal(paperIsOnPaper([true]), true); assert.equal(paperIsOnPaper([true, true]), true);
  assert.equal(paperIsOnPaper([true, false]), false, 'one ordinary theory set means students must type');
  assert.equal(paperIsOnPaper([false]), false);
  assert.equal(paperIsOnPaper([]), false, 'no theory at all is not an on-paper paper');
});
check('only a theory set can carry the flag', () => {
  assert.equal(setFlag('theory', true), true); assert.equal(setFlag('theory', false), false);
  assert.equal(setFlag('objective', true), false, 'an objective set is never on paper');
});
check('a typed answer is refused only for theory on an on-paper paper', () => {
  assert.equal(typedAnswerRefused(true, 'theory'), true);
  assert.equal(typedAnswerRefused(true, 'single_choice'), false, 'objective questions are still answered on the computer');
  assert.equal(typedAnswerRefused(false, 'theory'), false, 'an ordinary paper still takes typed theory');
});
console.log(`${passed} theory delivery rule checks passed`);
