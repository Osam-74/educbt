import assert from 'node:assert/strict';
import { DEFAULT_RANKING } from '@/domain/academic';
import { reportAverage, reportGradingKey, reportPositions } from './summary';
let passed = 0;
function check(label: string, fn: () => void) { fn(); console.log('PASS  ' + label); passed++; }
const cohort = [1, 2].map(studentId => ({ studentId, admissionNumber: String(studentId) }));
const row = (studentId: number, subjectId: number, total: string, complete = true) => ({ studentId, subjectId, total, examTotal: total, complete });
const regs = [1, 2].flatMap(studentId => [1, 2].map(subjectId => ({ studentId, subjectId })));
const rows = [row(1, 1, '100'), row(2, 1, '70'), row(2, 2, '70')];
check('missing registered result cannot beat complete student', () => { const p = reportPositions(cohort, rows, regs, DEFAULT_RANKING); assert.equal(p.get(1), null); assert.equal(p.get(2), 1); });
check('incomplete stored component prevents class ranking', () => assert.equal(reportPositions(cohort, [...rows, row(1, 2, '90', false)], regs, DEFAULT_RANKING).get(1), null));
check('complete cohort retains normal positions', () => { const p = reportPositions(cohort, [...rows, row(1, 2, '90')], regs, DEFAULT_RANKING); assert.equal(p.get(1), 1); assert.equal(p.get(2), 2); });
check('explicit stored rankIncomplete policy is respected', () => assert.equal(reportPositions(cohort, rows, regs, { ...DEFAULT_RANKING, rankIncomplete: true }).get(1), 1));
check('student with no scored subjects has no invented average rank', () => assert.equal(reportPositions(cohort, [], regs, DEFAULT_RANKING).size, 0));
check('zero is a real average', () => assert.equal(reportAverage([0, 0]), '0%'));
check('missing average stays missing', () => assert.equal(reportAverage([]), '—'));
check('decimal averages retain one-place rounding', () => assert.equal(reportAverage([60, 61, 61]), '60.7%'));
check('known WAEC version renders its key', () => assert(reportGradingKey([{ scaleId: 'waec-9', scaleVersion: 1 }]).includes('A1: 75–100')));
for (const rows of [[{ scaleId: 'school-five-point', scaleVersion: 1 }], [{ scaleId: 'waec-9', scaleVersion: 2 }], [{ scaleId: 'waec-9', scaleVersion: 1 }, { scaleId: 'other', scaleVersion: 1 }]]) {
  check('unknown or mixed historical scales never claim WAEC bands', () => { const key = reportGradingKey(rows); assert(key.includes('unavailable')); assert(!key.includes('A1:')); });
}
check('no compiled scale is explicitly absent', () => assert.equal(reportGradingKey([]), 'No compiled grading scale available.'));
console.log(`${passed} PASS / 0 FAIL`);
