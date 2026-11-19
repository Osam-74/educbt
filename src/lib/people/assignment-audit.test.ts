/** npx tsx src/lib/people/assignment-audit.test.ts */
import assert from 'node:assert/strict';
import { findCrossProductSuspects as f } from './assignment-audit';
let n = 0; const check = (name: string, fn: () => void) => { fn(); n++; console.log('PASS  ' + name); };
const grid = (staffId: number, subs: number[], cls: number[]) => subs.flatMap((subjectId) => cls.map((classId) => ({ staffId, subjectId, classId })));

check('a full 2 by 2 grid is flagged, with the subjects, classes and count', () => { assert.deepEqual(f(grid(1, [10, 11], [5, 6])), [{ staffId: 1, subjectIds: [10, 11], classIds: [5, 6], assignments: 4 }]); });
check('a teacher with different subjects in different classes (the correct result) is not flagged', () => { assert.deepEqual(f([{ staffId: 1, subjectId: 10, classId: 5 }, { staffId: 1, subjectId: 11, classId: 6 }]), []); });
check('a partial grid (3 of 4) looks deliberate and is not flagged', () => { assert.deepEqual(f(grid(1, [10, 11], [5, 6]).slice(0, 3)), []); });
check('one subject across many classes, or many subjects in one class, is ordinary and not flagged', () => { assert.deepEqual(f(grid(1, [10], [5, 6, 7])), []); assert.deepEqual(f(grid(1, [10, 11, 12], [5])), []); });
check('teachers are judged separately, and the biggest grid comes first', () => { const r = f([...grid(1, [10, 11], [5, 6]), ...grid(2, [10, 11, 12], [5, 6]), ...grid(3, [10], [5])]); assert.deepEqual(r.map((s) => s.staffId), [2, 1]); });
check('an extra stray assignment on top of a grid means it is not a pure grid, so it is not flagged', () => { assert.deepEqual(f([...grid(1, [10, 11], [5, 6]), { staffId: 1, subjectId: 12, classId: 5 }]), []); });
check('no assignments gives no suspects', () => { assert.deepEqual(f([]), []); });
console.log(`\n${n} checks passed.`);
