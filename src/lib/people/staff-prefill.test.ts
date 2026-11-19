/**
 * Pure unit test for buildAssignmentPrefill — no database needed.
 *   npx tsx src/lib/people/staff-prefill.test.ts
 *
 * Pins down the bug reported 2026-09-19: a teacher who was a subject teacher
 * of one class and then given a class-teacher duty on a DIFFERENT class had
 * the subject-teacher class show up pre-selected (and toggling the "What are
 * you assigning?" kind afterwards left it stuck there) in the class-teacher
 * builder — the two duty types were sharing one class/level list.
 */
import assert from 'node:assert/strict';
import { buildAssignmentPrefill, groupDutyRows } from './staff';

function main() {
  let count = 0;
  const check = (name: string, fn: () => void) => { fn(); count++; console.log('PASS  ' + name); };

  check('a teacher with only a subject-teacher duty gets no class-teacher levels', () => {
    const prefill = buildAssignmentPrefill(
      [{ staffId: 1, type: 'subject_teacher', levelId: 10, subjectId: 100 }],
      [1],
    );
    assert.deepEqual(prefill[1]!.classTeacherLevelIds, []);
    assert.deepEqual(prefill[1]!.subjectTeacherLevelIds, [10]);
    assert.deepEqual(prefill[1]!.subjectIds, [100]);
  });

  check('class teacher of one level and subject teacher of a different level stay separate', () => {
    // The exact reported scenario: staff 1 is the class teacher of level 20,
    // and (separately) a subject teacher of level 10. Neither list may leak
    // into the other.
    const prefill = buildAssignmentPrefill([
      { staffId: 1, type: 'class_teacher', levelId: 20, subjectId: null },
      { staffId: 1, type: 'subject_teacher', levelId: 10, subjectId: 100 },
      { staffId: 1, type: 'subject_teacher', levelId: 10, subjectId: 101 },
    ], [1]);
    assert.deepEqual(prefill[1]!.classTeacherLevelIds, [20]);
    assert.deepEqual(prefill[1]!.subjectTeacherLevelIds, [10]);
    assert.deepEqual(new Set(prefill[1]!.subjectIds), new Set([100, 101]));
    // The old bug: classTeacherLevelIds would have included 10 (or
    // subjectTeacherLevelIds would have included 20) because both were
    // folded into one `levelIds` set regardless of duty type.
    assert.ok(!prefill[1]!.classTeacherLevelIds.includes(10));
    assert.ok(!prefill[1]!.subjectTeacherLevelIds.includes(20));
  });

  check('a duty for an inactive/unlisted staff id is ignored', () => {
    const prefill = buildAssignmentPrefill(
      [{ staffId: 99, type: 'class_teacher', levelId: 5, subjectId: null }],
      [1],
    );
    assert.equal(prefill[99], undefined);
    assert.deepEqual(prefill[1], { classTeacherLevelIds: [], subjectTeacherLevelIds: [], subjectIds: [], classTeacherClassIds: [], subjectTeacherClassIds: [], subjectClasses: {} });
  });

  check('every active staff id gets an entry even with no duties at all', () => {
    const prefill = buildAssignmentPrefill([], [1, 2]);
    assert.deepEqual(prefill[1], { classTeacherLevelIds: [], subjectTeacherLevelIds: [], subjectIds: [], classTeacherClassIds: [], subjectTeacherClassIds: [], subjectClasses: {} });
    assert.deepEqual(prefill[2], { classTeacherLevelIds: [], subjectTeacherLevelIds: [], subjectIds: [], classTeacherClassIds: [], subjectTeacherClassIds: [], subjectClasses: {} });
  });

  check('a teacher on ONE arm of a level is pre-filled with that arm only, never the whole level', () => {
    const prefill = buildAssignmentPrefill([
      { staffId: 1, type: 'subject_teacher', levelId: 10, classId: 1001, subjectId: 100 },
    ], [1]);
    assert.deepEqual(prefill[1]!.subjectTeacherClassIds, [1001]);
  });

  check('two arms of one level, and an arm of another level, are all kept apart', () => {
    const prefill = buildAssignmentPrefill([
      { staffId: 1, type: 'subject_teacher', levelId: 10, classId: 1001, subjectId: 100 },
      { staffId: 1, type: 'subject_teacher', levelId: 10, classId: 1002, subjectId: 100 },
      { staffId: 1, type: 'subject_teacher', levelId: 20, classId: 2001, subjectId: 101 },
    ], [1]);
    assert.deepEqual(new Set(prefill[1]!.subjectTeacherClassIds), new Set([1001, 1002, 2001]));
  });

  check('REPORTED BUG: Subject A in SS1-3 and Subject B in SS1 only is two rows, so B is never widened to SS2 and SS3', () => {
    const prefill = buildAssignmentPrefill([
      { staffId: 1, type: 'subject_teacher', levelId: 1, classId: 11, subjectId: 100 },
      { staffId: 1, type: 'subject_teacher', levelId: 2, classId: 21, subjectId: 100 },
      { staffId: 1, type: 'subject_teacher', levelId: 3, classId: 31, subjectId: 100 },
      { staffId: 1, type: 'subject_teacher', levelId: 1, classId: 11, subjectId: 200 },
    ], [1]);
    const rows = groupDutyRows(prefill[1]!.subjectClasses);
    assert.equal(rows.length, 2);
    const pairs = rows.flatMap((r) => r.subjectIds.flatMap((s) => r.classIds.map((c) => `${s}:${c}`))).sort();
    assert.deepEqual(pairs, ['100:11', '100:21', '100:31', '200:11']);
    assert.ok(!pairs.includes('200:21') && !pairs.includes('200:31'));
  });

  check('subjects taken in exactly the same classes share one row', () => {
    const rows = groupDutyRows({ 100: [11, 21], 200: [21, 11], 300: [31] });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((r) => r.subjectIds.includes(100))!.subjectIds.sort(), [100, 200]);
  });

  check('loading then saving writes exactly what was held, over 500 random duty sets', () => {
    let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let t = 0; t < 500; t++) {
      const held: Record<number, number[]> = {};
      for (let s = 0; s < 1 + rnd(5); s++) { held[s + 1] = Array.from({ length: rnd(6) }, () => 1 + rnd(8)); }
      const want = new Set<string>(); for (const [s, cs] of Object.entries(held)) for (const c of cs) want.add(`${s}:${c}`);
      const got = new Set(groupDutyRows(held).flatMap((r) => r.subjectIds.flatMap((s) => r.classIds.map((c) => `${s}:${c}`))));
      assert.deepEqual([...got].sort(), [...want].sort());
    }
  });

  check('class-teacher arms and subject-teacher arms never mix', () => {
    const prefill = buildAssignmentPrefill([
      { staffId: 1, type: 'class_teacher', levelId: 20, classId: 2001, subjectId: null },
      { staffId: 1, type: 'subject_teacher', levelId: 10, classId: 1001, subjectId: 100 },
    ], [1]);
    assert.deepEqual(prefill[1]!.classTeacherClassIds, [2001]);
    assert.deepEqual(prefill[1]!.subjectTeacherClassIds, [1001]);
  });

  check('two teachers on the same subject and arm each keep their own arm', () => {
    const prefill = buildAssignmentPrefill([
      { staffId: 1, type: 'subject_teacher', levelId: 10, classId: 1001, subjectId: 100 },
      { staffId: 2, type: 'subject_teacher', levelId: 10, classId: 1001, subjectId: 100 },
    ], [1, 2]);
    assert.deepEqual(prefill[1]!.subjectTeacherClassIds, [1001]);
    assert.deepEqual(prefill[2]!.subjectTeacherClassIds, [1001]);
  });

  check('a duty row with no classId (older callers) still works and adds no arms', () => {
    const prefill = buildAssignmentPrefill([{ staffId: 1, type: 'subject_teacher', levelId: 10, subjectId: 100 }], [1]);
    assert.deepEqual(prefill[1]!.subjectTeacherClassIds, []);
    assert.deepEqual(prefill[1]!.subjectTeacherLevelIds, [10]);
  });

  console.log(`\n${count} checks passed.`);
}

main();
