import assert from 'node:assert/strict';
import { normaliseGender, fold, totals, axisTop, shortLabel, barLabel, LABEL_MAX } from './rules';

let count = 0;
const check = (name: string, fn: () => void) => { fn(); count++; console.log('PASS  ' + name); };

check('every way of typing male is male', () => { for (const g of ['male', 'Male', ' MALE ', 'm', 'M', 'boy', 'Boy']) assert.equal(normaliseGender(g), 'male', g); });
check('every way of typing female is female', () => { for (const g of ['female', 'Female', ' FEMALE ', 'f', 'F', 'girl', 'Girl']) assert.equal(normaliseGender(g), 'female', g); });
check('blank, missing or anything else is "not stated", never dropped', () => { for (const g of ['', '  ', null, undefined, 'other', 'mf', 'x', '0']) assert.equal(normaliseGender(g as string), 'unknown', String(g)); });
check('"female" is not mistaken for "male" (it contains the letters)', () => assert.equal(normaliseGender('female'), 'female'));

const rows = [
  { classId: 1, className: 'SS1', gender: 'Male', n: 10 }, { classId: 1, className: 'SS1', gender: 'f', n: 12 }, { classId: 1, className: 'SS1', gender: null, n: 2 },
  { classId: 2, className: 'SS2', gender: 'M', n: 5 }, { classId: 1, className: 'SS1', gender: 'male', n: 3 },
];
check('fold merges differently typed genders for one class, and keeps first-seen class order', () => {
  const f = fold(rows);
  assert.deepEqual(f.map((c) => c.classId), [1, 2]);
  assert.deepEqual(f[0], { classId: 1, name: 'SS1', male: 13, female: 12, unknown: 2, total: 27 });
  assert.deepEqual(f[1], { classId: 2, name: 'SS2', male: 5, female: 0, unknown: 0, total: 5 });
});
check('every class total equals male + female + not stated (the bars add up)', () => { for (const c of fold(rows)) assert.equal(c.total, c.male + c.female + c.unknown); });
check('counts arriving as text, negative or fractional are made safe', () => {
  const f = fold([{ classId: 1, className: 'A', gender: 'm', n: '4' as unknown as number }, { classId: 1, className: 'A', gender: 'f', n: -3 }, { classId: 1, className: 'A', gender: 'f', n: 2.9 }]);
  assert.deepEqual(f[0], { classId: 1, name: 'A', male: 4, female: 2, unknown: 0, total: 6 });
});
check('no rows gives no classes and zero totals', () => { assert.deepEqual(fold([]), []); assert.deepEqual(totals([]), { male: 0, female: 0, unknown: 0, total: 0 }); });
check('totals add every class', () => assert.deepEqual(totals(fold(rows)), { male: 18, female: 12, unknown: 2, total: 32 }));

check('the axis top is a nice number at or above the tallest bar', () => {
  const cases: Array<[number, number]> = [[0, 5], [1, 5], [5, 5], [6, 10], [10, 10], [11, 20], [21, 25], [26, 50], [51, 100], [101, 200], [999, 1000], [1001, 2000], [5000, 5000], [5001, 5100], [7342, 7400]];
  for (const [max, top] of cases) { assert.equal(axisTop(max), top, `max ${max}`); assert.ok(axisTop(max) >= max); }
});
check('a short class name is left alone; a long one is cut with an ellipsis at the limit', () => {
  assert.equal(shortLabel('SS1 A'), 'SS1 A');
  assert.equal(shortLabel('x'.repeat(LABEL_MAX)), 'x'.repeat(LABEL_MAX), 'exactly the limit is not cut');
  const cut = shortLabel('x'.repeat(LABEL_MAX + 1)); assert.equal([...cut].length, LABEL_MAX); assert.ok(cut.endsWith('…'));
});
check('cutting never splits a multi-byte character', () => { const cut = shortLabel('é'.repeat(40)); assert.equal([...cut].length, LABEL_MAX); assert.ok(!cut.includes('\uFFFD')); });
check('the spoken label gives full name, counts, singular/plural, and mentions "not stated" only when there is one', () => {
  assert.equal(barLabel({ classId: 1, name: 'SS1', male: 1, female: 0, unknown: 0, total: 1 }), 'SS1: 1 student, 1 male, 0 female');
  assert.equal(barLabel({ classId: 1, name: 'SS1', male: 13, female: 12, unknown: 2, total: 27 }), 'SS1: 27 students, 13 male, 12 female, 2 not stated');
});

console.log(`${count} population rule checks passed`);
