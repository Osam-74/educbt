/** Pure tests for the class timetable rules.  npx tsx src/lib/calendar/timetable-rules.test.ts */
import assert from 'node:assert/strict';
import { canEditClassTimetable, canEditPeriods, lessonProblems, periodsProblems, timetableWeekday, lessonsOn, dayLoad, type LessonCheck } from './timetable-rules';

let n = 0; const check = (name: string, fn: () => void) => { fn(); n++; console.log('PASS  ' + name); };
const ok: LessonCheck = { periodIsBreak: false, weekday: 2, subjectTaughtInClass: true, teacherAssigned: true, classSlotTaken: false, teacherBusyWith: null };

check('the class teacher edits their own class only; another class is refused', () => {
  assert.ok(canEditClassTimetable('teacher', 5, [5, 6])); assert.ok(!canEditClassTimetable('teacher', 7, [5, 6])); assert.ok(!canEditClassTimetable('teacher', 5, []));
});
check('principal, vice principal and exam officer edit any class', () => { for (const r of ['principal', 'vice_principal', 'exam_officer']) assert.ok(canEditClassTimetable(r, 99, [])); });
check('students and parents never edit, even if a class id is passed', () => { for (const r of ['student', 'parent', 'platform_admin', '']) assert.ok(!canEditClassTimetable(r, 5, [5])); });
check('only the calendar managers set the school\'s bell schedule, not class teachers', () => { assert.ok(canEditPeriods('principal') && canEditPeriods('exam_officer')); assert.ok(!canEditPeriods('teacher') && !canEditPeriods('student')); });
check('a valid lesson has no problems', () => assert.deepEqual(lessonProblems(ok), []));
check('each rule is reported on its own, in plain words', () => {
  assert.match(lessonProblems({ ...ok, periodIsBreak: true })[0]!, /break/); assert.match(lessonProblems({ ...ok, weekday: 0 })[0]!, /day of the week/); assert.match(lessonProblems({ ...ok, weekday: 8 })[0]!, /day of the week/);
  assert.match(lessonProblems({ ...ok, subjectTaughtInClass: false })[0]!, /not taught/); assert.match(lessonProblems({ ...ok, teacherAssigned: false })[0]!, /not assigned/);
  assert.match(lessonProblems({ ...ok, classSlotTaken: true })[0]!, /already has a lesson/); assert.match(lessonProblems({ ...ok, teacherBusyWith: 'JSS2 Gold' })[0]!, /JSS2 Gold/);
});
check('no teacher chosen is allowed; several problems are all reported', () => {
  assert.deepEqual(lessonProblems({ ...ok, teacherAssigned: null }), []); assert.equal(lessonProblems({ ...ok, periodIsBreak: true, classSlotTaken: true, teacherBusyWith: 'X' }).length, 3);
});
check('a bell schedule: good one passes; bad times, backwards periods, overlaps, duplicates and empties are refused', () => {
  const good = [{ name: 'P1', startTime: '08:00', endTime: '08:40' }, { name: 'P2', startTime: '08:40', endTime: '09:20' }, { name: 'Break', startTime: '09:20', endTime: '09:40' }];
  assert.deepEqual(periodsProblems(good), []);
  assert.ok(periodsProblems([]).length); assert.ok(periodsProblems([{ name: '', startTime: '08:00', endTime: '09:00' }])[0]!.includes('name'));
  assert.ok(periodsProblems([{ name: 'A', startTime: '8am', endTime: '09:00' }])[0]!.includes('valid times')); assert.ok(periodsProblems([{ name: 'A', startTime: '10:00', endTime: '09:00' }])[0]!.includes('end after'));
  assert.ok(periodsProblems([{ name: 'A', startTime: '08:00', endTime: '09:00' }, { name: 'B', startTime: '08:30', endTime: '09:30' }])[0]!.includes('overlap'));
  assert.ok(periodsProblems([{ name: 'A', startTime: '08:00', endTime: '09:00' }, { name: 'a', startTime: '09:00', endTime: '10:00' }])[0]!.includes('same name'));
  assert.ok(periodsProblems(Array.from({ length: 21 }, (_, i) => ({ name: `P${i}`, startTime: '08:00', endTime: '09:00' }))).some((m) => m.includes('20')));
});
check('weekday numbering: Monday is 1 and Sunday is 7', () => { assert.equal(timetableWeekday(1), 1); assert.equal(timetableWeekday(5), 5); assert.equal(timetableWeekday(0), 7); });
check('lessons on a date: none on a non-teaching day (holiday, weekend, break), the weekday\'s lessons otherwise', () => {
  const L = [{ id: 1, classId: 1, periodId: 1, weekday: 4, subjectId: 1, staffId: 1 }, { id: 2, classId: 1, periodId: 2, weekday: 4, subjectId: 2, staffId: 2 }, { id: 3, classId: 1, periodId: 1, weekday: 5, subjectId: 1, staffId: 1 }];
  const days = new Set(['2026-11-19', '2026-11-20']);
  assert.deepEqual(lessonsOn('2026-11-19', 4, L, days).map((l) => l.id), [1, 2]); assert.deepEqual(lessonsOn('2026-11-20', 5, L, days).map((l) => l.id), [3]);
  assert.deepEqual(lessonsOn('2026-11-19', 4, L, new Set()), [], 'a holiday empties the day'); assert.deepEqual(lessonsOn('2026-11-21', 6, L, days), []);
});
check('day load counts lessons per weekday', () => { assert.deepEqual(dayLoad([{ id: 1, classId: 1, periodId: 1, weekday: 1, subjectId: 1, staffId: 1 }, { id: 2, classId: 1, periodId: 2, weekday: 1, subjectId: 1, staffId: 1 }, { id: 3, classId: 1, periodId: 1, weekday: 3, subjectId: 1, staffId: 1 }]), { 1: 2, 3: 1 }); });
console.log(`\n${n} checks passed.`);
