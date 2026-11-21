import assert from 'node:assert/strict';
import { armRefusal, ARM_BATCH_LIMIT } from './arm-assignment';

let count = 0;
const check = (name: string, fn: () => void) => { fn(); count++; console.log('PASS  ' + name); };
const from = { classId: 1, levelId: 10 };
const to = { classId: 2, levelId: 10, active: true };
const ok = { enrolledThisSession: true, scoresThisTerm: 0, resultsThisTerm: 0 };

check('a clean move to another active arm of the same level is allowed', () => assert.equal(armRefusal(from, to, ok), ''));
check('not enrolled this session is refused first', () => assert.match(armRefusal(from, to, { ...ok, enrolledThisSession: false }), /Not enrolled in the current session/));
check('the same class is refused', () => assert.match(armRefusal(from, { ...to, classId: 1 }, ok), /Already in that class/));
check('an inactive class is refused', () => assert.match(armRefusal(from, { ...to, active: false }, ok), /not active/));
check('a different level is refused and points to Promotion', () => assert.match(armRefusal(from, { ...to, levelId: 11 }, ok), /different level.*Promotion/));
check('a class with no level is refused', () => assert.match(armRefusal(from, { ...to, levelId: 0 }, ok), /different level/));
check('compiled results this term are refused, naming how many', () => {
  assert.match(armRefusal(from, to, { ...ok, resultsThisTerm: 1 }), /results compiled this term \(1 subject\)/);
  assert.match(armRefusal(from, to, { ...ok, resultsThisTerm: 4 }), /\(4 subjects\)/);
});
check('scores already recorded this term are refused, singular and plural', () => {
  assert.match(armRefusal(from, to, { ...ok, scoresThisTerm: 1 }), /Already has 1 score recorded/);
  assert.match(armRefusal(from, to, { ...ok, scoresThisTerm: 7 }), /Already has 7 scores recorded/);
});
check('compiled results are reported ahead of loose scores (the stronger reason)', () => assert.match(armRefusal(from, to, { ...ok, scoresThisTerm: 5, resultsThisTerm: 2 }), /results compiled/));
check('a full arm is refused, one with room or no limit is not', () => {
  assert.match(armRefusal(from, { ...to, capacity: 30, occupied: 30 }, ok), /reached its capacity/);
  assert.match(armRefusal(from, { ...to, capacity: 30, occupied: 31 }, ok), /reached its capacity/);
  assert.equal(armRefusal(from, { ...to, capacity: 30, occupied: 29 }, ok), '');
  assert.equal(armRefusal(from, { ...to, capacity: 0, occupied: 500 }, ok), '', 'capacity 0 means no limit');
  assert.equal(armRefusal(from, to, ok), '', 'no capacity information at all means no limit');
});
check('the order of the rules is stable: session, then same class, then active, then level', () => {
  assert.match(armRefusal(from, { classId: 1, levelId: 99, active: false }, { ...ok, enrolledThisSession: false }), /Not enrolled/);
  assert.match(armRefusal(from, { classId: 1, levelId: 99, active: false }, ok), /Already in that class/);
  assert.match(armRefusal(from, { classId: 2, levelId: 99, active: false }, ok), /not active/);
});
check('the batch limit matches the plugin (500)', () => assert.equal(ARM_BATCH_LIMIT, 500));

console.log(`${count} arm assignment rule checks passed`);
