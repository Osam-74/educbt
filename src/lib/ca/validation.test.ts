import assert from 'node:assert/strict';
import { caComponents, caScoreSchema, parseCaForm } from './validation';
let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log('PASS  ' + name); }
const base = { classId: 1, studentId: 2, subjectId: 3, sessionId: 4, termId: 5, componentKey: 'ca1', score: 0, maxScore: 20 };
const form = () => { const f = new FormData(); Object.entries(base).forEach(([k,v]) => f.set(k, String(v))); return f; };
check('zero is an entered score', () => assert.equal(parseCaForm(form())?.score, 0));
check('full marks accepted', () => assert(caScoreSchema.safeParse({ ...base, score: 20 }).success));
check('two decimal places accepted', () => assert(caScoreSchema.safeParse({ ...base, score: 1.23 }).success));
for (const [label, value] of [['blank', ''], ['whitespace', ' '], ['NaN', 'NaN'], ['infinity', 'Infinity'], ['negative', '-1'], ['precision', '1.234']] as const) {
  check(label + ' rejected', () => { const f = form(); f.set('score', value); assert.equal(parseCaForm(f), null); });
}
check('duplicate fields rejected', () => { const f = form(); f.append('studentId', '9'); assert.equal(parseCaForm(f), null); });
check('file input rejected', () => { const f = form(); f.set('score', new Blob(['1'])); assert.equal(parseCaForm(f), null); });
check('missing scope rejected', () => { const f = form(); f.delete('sessionId'); assert.equal(parseCaForm(f), null); });
check('unsafe numeric IDs rejected', () => assert(!caScoreSchema.safeParse({ ...base, studentId: Number.MAX_SAFE_INTEGER + 1 }).success));
check('invalid component key rejected', () => assert(!caScoreSchema.safeParse({ ...base, componentKey: 'ca 1' }).success));
check('negative maximum rejected', () => assert(!caScoreSchema.safeParse({ ...base, maxScore: -1 }).success));
const component = { key: 'ca1', label: 'First CA', maxScore: 20, isExam: false };
check('only CA components available', () => assert.deepEqual(caComponents({ assessmentComponents: [component, { ...component, key: 'exam', isExam: true }] }), [component]));
check('absent configuration fails closed', () => assert.deepEqual(caComponents({}), []));
check('malformed configuration fails closed', () => assert.deepEqual(caComponents({ assessmentComponents: [{ ...component, maxScore: '20' }] }), []));
check('duplicate component keys fail closed', () => assert.deepEqual(caComponents({ assessmentComponents: [component, component] }), []));
check('zero maximum fails closed', () => assert.deepEqual(caComponents({ assessmentComponents: [{ ...component, maxScore: 0 }] }), []));
console.log(count + ' PASS / 0 FAIL');
