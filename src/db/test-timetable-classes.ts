/**
 * Class teaching timetable integration checks. Disposable LOCAL database only:
 *   npx tsx src/db/test-timetable-classes.ts
 * The headline rule: the CLASS TEACHER sets the timetable of THEIR class and
 * nothing else; leadership and the exam officer set any; everyone else reads.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

const schoolIds: number[] = [];

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) if (!process.env[key]) throw new Error(`Timetable tests require ${key}.`);
  const { schema, forSchool, client: appSingleton } = await import('@/db');
  const tt = await import('@/lib/calendar/timetable-service');
  const cal = await import('@/lib/calendar/service');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const rejects = async (name: string, fn: () => unknown | Promise<unknown>, fragment?: string) => {
    try { await fn(); } catch (error) {
      if (fragment && !(error instanceof Error && error.message.includes(fragment))) throw new Error(`${name}: expected "${fragment}", got "${error instanceof Error ? error.message : error}"`);
      count++; console.log('PASS  ' + name); return;
    }
    throw new Error(`${name}: expected a rejection, got success`);
  };
  const actor = (userId: number, schoolId: number, role: string, staffId: number | null = null, studentId: number | null = null): Actor => ({ userId, schoolId, role, loginId: 'test', staffId, studentId });
  const fail = (r: { ok: boolean; errors?: string[] }) => (r.errors ?? []).join(' | ');

  async function fixture(tag: string) {
    const code = 'TT' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: `TT ${tag}`, code, settings: {} }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true, startsOn: new Date('2026-09-01T00:00:00Z'), endsOn: new Date('2027-07-31T00:00:00Z') }).returning();
    const sessionId = session!.id;
    await db.insert(schema.terms).values({ schoolId, sessionId, title: 'First Term', position: 1, startsOn: new Date('2026-09-14T00:00:00Z'), endsOn: new Date('2026-12-11T00:00:00Z'), isCurrent: true });
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
    const [c1, c2] = (await db.insert(schema.classes).values([{ schoolId, levelId: level!.id, displayName: 'JSS1 Gold', arm: 'Gold' }, { schoolId, levelId: level!.id, displayName: 'JSS1 Green', arm: 'Green' }]).returning()) as unknown as [{ id: number }, { id: number }];
    const user = async (role: 'principal' | 'vice_principal' | 'exam_officer' | 'teacher' | 'student' | 'parent', t = '') => (await db.insert(schema.users).values({ schoolId, role, loginId: `${role}${t}-${code}`, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning())[0]!;
    const principal = await user('principal'), examOfficer = await user('exam_officer');
    const mk = async (t: string) => { const u = await user('teacher', t); const s = (await db.insert(schema.staff).values({ schoolId, userId: u.id, staffNumber: `${code}/${t}`, firstName: 'T', lastName: t, email: `${t.toLowerCase()}.${code.toLowerCase()}@example.com`, role: 'teacher', status: 'active' }).returning())[0]!; return { u, s }; };
    const gold = await mk('Gold'), green = await mk('Green'), maths = await mk('Maths'), eng = await mk('English');
    const sub = async (name: string, c: string) => (await db.insert(schema.subjects).values({ schoolId, code: c, name }).returning())[0]!;
    const mth = await sub('Mathematics', 'MTH'), en = await sub('English', 'ENG'), bio = await sub('Biology', 'BIO');
    const asg = (staffId: number, classId: number, type: 'class_teacher' | 'subject_teacher', subjectId?: number) => ({ schoolId, staffId, classId, assignmentType: type, status: 'active', ...(subjectId ? { subjectId } : {}) });
    await db.insert(schema.staffAssignments).values([
      asg(gold.s.id, c1.id, 'class_teacher'), asg(green.s.id, c2.id, 'class_teacher'),
      asg(maths.s.id, c1.id, 'subject_teacher', mth.id), asg(maths.s.id, c2.id, 'subject_teacher', mth.id), asg(eng.s.id, c1.id, 'subject_teacher', en.id),
    ]);
    const stu = async (t: string, classId: number) => { const u = await user('student', t); const s = (await db.insert(schema.students).values({ schoolId, userId: u.id, admissionNumber: `${code}/${t}`, firstName: t, lastName: 'S', status: 'active' }).returning())[0]!; await db.insert(schema.enrollments).values({ schoolId, studentId: s.id, classId, sessionId, status: 'active' }); return { u, s }; };
    const sGold = await stu('G', c1.id), sGreen = await stu('R', c2.id);
    const pu = await user('parent', 'G'); const [g] = await db.insert(schema.guardians).values({ schoolId, userId: pu.id, fullName: 'Parent', email: pu.loginId, inviteStatus: 'accepted' }).returning();
    await db.insert(schema.guardianStudent).values({ schoolId, guardianId: g!.id, studentId: sGold.s.id, canViewResults: true });
    return { schoolId, sessionId, c1, c2, principal, examOfficer, gold, green, maths, eng, mth, en, bio, sGold, sGreen, pu };
  }

  const F = await fixture('one'), G = await fixture('two');
  const P = actor(F.principal.id, F.schoolId, 'principal'), EO = actor(F.examOfficer.id, F.schoolId, 'exam_officer');
  const GOLD = actor(F.gold.u.id, F.schoolId, 'teacher', F.gold.s.id), GREEN = actor(F.green.u.id, F.schoolId, 'teacher', F.green.s.id);
  const MATHS = actor(F.maths.u.id, F.schoolId, 'teacher', F.maths.s.id), ENG = actor(F.eng.u.id, F.schoolId, 'teacher', F.eng.s.id);
  const SG = actor(F.sGold.u.id, F.schoolId, 'student', null, F.sGold.s.id), SR = actor(F.sGreen.u.id, F.schoolId, 'student', null, F.sGreen.s.id), PG = actor(F.pu.id, F.schoolId, 'parent');
  const PB = actor(G.principal.id, G.schoolId, 'principal');

  console.log('── the school\'s periods ──');
  await check('the principal sets the day: periods and a break, in time order', async () => {
    const r = await tt.savePeriods(P, [{ name: 'Period 1', startTime: '08:00', endTime: '08:40' }, { name: 'Period 2', startTime: '08:40', endTime: '09:20' }, { name: 'Break', startTime: '09:20', endTime: '09:40', isBreak: true }, { name: 'Period 3', startTime: '09:40', endTime: '10:20' }]); assert.ok(r.ok, fail(r));
    const p = (await tt.loadTimetable(P, F.sessionId)).periods; assert.deepEqual(p.map((x) => x.name), ['Period 1', 'Period 2', 'Break', 'Period 3']); assert.ok(p[2]!.isBreak);
  });
  await check('a class teacher, a subject teacher, a student and a parent cannot change the school\'s periods', async () => {
    for (const who of [GOLD, MATHS, SG, PG]) await rejects('periods', () => tt.savePeriods(who, [{ name: 'X', startTime: '08:00', endTime: '09:00' }]), 'principal, vice principal or exam officer');
  });
  await check('bad periods are refused in plain words and nothing changes', async () => {
    const r = await tt.savePeriods(P, [{ name: 'A', startTime: '08:00', endTime: '09:00' }, { name: 'B', startTime: '08:30', endTime: '09:30' }]); assert.ok(!r.ok && fail(r).includes('overlap'));
    assert.equal((await tt.loadTimetable(P, F.sessionId)).periods.length, 4);
  });
  const periods = (await tt.loadTimetable(P, F.sessionId)).periods; const P1 = periods[0]!, P2 = periods[1]!, BRK = periods[2]!, P3 = periods[3]!;

  console.log('── the class teacher sets THEIR class, and only theirs ──');
  let l1 = 0;
  await check('the Gold class teacher adds a lesson to JSS1 Gold', async () => {
    const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P1.id, weekday: 1, subjectId: F.mth.id, staffId: F.maths.s.id, room: 'Room 4' }); assert.ok(r.ok, fail(r)); l1 = (r as { id: number }).id;
    const v = await tt.loadTimetable(GOLD, F.sessionId, F.c1.id); assert.equal(v.lessons.length, 1); assert.equal(v.lessons[0]!.subjectName, 'Mathematics'); assert.equal(v.lessons[0]!.room, 'Room 4'); assert.ok(v.canEdit);
  });
  await check('the Gold class teacher CANNOT set JSS1 Green: add, edit, remove or publish are all refused', async () => {
    await rejects('add', () => tt.saveLesson(GOLD, F.sessionId, { classId: F.c2.id, periodId: P1.id, weekday: 1, subjectId: F.mth.id }), 'class teacher of');
    const g = await tt.saveLesson(GREEN, F.sessionId, { classId: F.c2.id, periodId: P1.id, weekday: 2, subjectId: F.mth.id, staffId: F.maths.s.id }); const gid = (g as { id: number }).id;
    await rejects('edit', () => tt.saveLesson(GOLD, F.sessionId, { classId: F.c2.id, periodId: P2.id, weekday: 2, subjectId: F.mth.id }, gid), 'class teacher of');
    await rejects('remove', () => tt.removeLesson(GOLD, gid), 'class teacher of'); await rejects('publish', () => tt.setTimetablePublished(GOLD, F.sessionId, F.c2.id, true), 'class teacher of');
    assert.equal((await tt.loadTimetable(P, F.sessionId, F.c2.id)).lessons.length, 1, 'Green is untouched');
  });
  await check('a subject teacher (not class teacher) cannot edit, even a class they teach in', async () => {
    await rejects('add', () => tt.saveLesson(MATHS, F.sessionId, { classId: F.c1.id, periodId: P2.id, weekday: 1, subjectId: F.mth.id, staffId: F.maths.s.id }), 'class teacher of');
    await rejects('remove', () => tt.removeLesson(MATHS, l1), 'class teacher of'); assert.equal((await tt.loadTimetable(MATHS, F.sessionId, F.c1.id)).canEdit, false);
  });
  await check('students and parents cannot edit', async () => {
    for (const who of [SG, PG]) { await rejects('add', () => tt.saveLesson(who, F.sessionId, { classId: F.c1.id, periodId: P2.id, weekday: 3, subjectId: F.mth.id }), 'class teacher of'); await rejects('rm', () => tt.removeLesson(who, l1), 'class teacher of'); }
  });
  await check('the principal and the exam officer can set ANY class', async () => {
    assert.ok((await tt.saveLesson(P, F.sessionId, { classId: F.c2.id, periodId: P2.id, weekday: 3, subjectId: F.mth.id, staffId: F.maths.s.id })).ok);
    assert.ok((await tt.saveLesson(EO, F.sessionId, { classId: F.c1.id, periodId: P2.id, weekday: 3, subjectId: F.en.id, staffId: F.eng.s.id })).ok);
  });
  await check('a class teacher sees only the classes they may open, and asking for another class does not reveal it', async () => {
    const v = await tt.loadTimetable(GOLD, F.sessionId, F.c2.id); assert.ok(v.classes.some((c) => c.id === F.c1.id)); assert.ok(!v.classes.some((c) => c.id === F.c2.id) || !v.classes.find((c) => c.id === F.c2.id)!.canEdit);
  });

  console.log('── what a lesson must satisfy ──');
  await check('no lesson in a break', async () => { const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: BRK.id, weekday: 2, subjectId: F.mth.id }); assert.ok(!r.ok && fail(r).includes('break')); });
  await check('only a subject the class has: Biology has no teacher in Gold, so it is refused', async () => { const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P3.id, weekday: 2, subjectId: F.bio.id }); assert.ok(!r.ok && fail(r).includes('not taught')); });
  await check('only a teacher assigned to that subject in that class: English teacher cannot be put on Mathematics', async () => { const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P3.id, weekday: 2, subjectId: F.mth.id, staffId: F.eng.s.id }); assert.ok(!r.ok && fail(r).includes('not assigned')); });
  await check('a class cannot have two lessons in one slot', async () => { const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P1.id, weekday: 1, subjectId: F.en.id, staffId: F.eng.s.id }); assert.ok(!r.ok && fail(r).includes('already has a lesson')); });
  await check('a teacher cannot be in two classes at once, and the message names the other class', async () => {
    // Maths already teaches Green in period 2 on Wednesday (set above); try Gold, same slot.
    const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P2.id, weekday: 3, subjectId: F.mth.id, staffId: F.maths.s.id }); assert.ok(!r.ok && (fail(r).includes('JSS1 Green') || fail(r).includes('already has a lesson')), fail(r));
    const r2 = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P3.id, weekday: 1, subjectId: F.mth.id, staffId: F.maths.s.id }); assert.ok(r2.ok, 'a free slot is fine');
    const r3 = await tt.saveLesson(P, F.sessionId, { classId: F.c2.id, periodId: P3.id, weekday: 1, subjectId: F.mth.id, staffId: F.maths.s.id }); assert.ok(!r3.ok && fail(r3).includes('JSS1 Gold'), fail(r3));
  });
  await check('moving a lesson to a free slot works, and editing a lesson does not clash with itself', async () => {
    assert.ok((await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P1.id, weekday: 1, subjectId: F.mth.id, staffId: F.maths.s.id, room: 'Lab' }, l1)).ok);
    assert.ok((await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P1.id, weekday: 4, subjectId: F.mth.id, staffId: F.maths.s.id }, l1)).ok);
    assert.equal((await tt.loadTimetable(GOLD, F.sessionId, F.c1.id)).lessons.find((l) => l.id === l1)!.weekday, 4);
  });
  await check('a lesson with no teacher chosen is allowed when the subject is taught in the class', async () => { assert.ok((await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P3.id, weekday: 5, subjectId: F.mth.id })).ok); });
  await check('a lesson from another school\'s subject, period or class is refused', async () => {
    const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P3.id, weekday: 2, subjectId: G.mth.id }); assert.ok(!r.ok && fail(r).includes('subject was not found'));
    await rejects('foreign class', () => tt.saveLesson(P, F.sessionId, { classId: G.c1.id, periodId: P3.id, weekday: 2, subjectId: F.mth.id }), 'class was not found');
  });
  await check('two people saving the SAME slot at the same instant: exactly one wins, the other is told plainly', async () => {
    const [a, b] = await Promise.all([
      tt.saveLesson(P, F.sessionId, { classId: F.c1.id, periodId: P2.id, weekday: 5, subjectId: F.en.id, staffId: F.eng.s.id }),
      tt.saveLesson(EO, F.sessionId, { classId: F.c1.id, periodId: P2.id, weekday: 5, subjectId: F.mth.id, staffId: F.maths.s.id }),
    ]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, JSON.stringify([a, b])); const loser = [a, b].find((x) => !x.ok)!; assert.ok(fail(loser).length > 0 && !fail(loser).includes('duplicate key'), fail(loser));
    const rows = await db.select().from(schema.timetableLessons).where(and(eq(schema.timetableLessons.classId, F.c1.id), eq(schema.timetableLessons.weekday, 5), eq(schema.timetableLessons.periodId, P2.id))); assert.equal(rows.length, 1, 'never two rows');
  });

  console.log('── removing, audit, periods that hold lessons ──');
  await check('removing a lesson deletes it and audits who and what', async () => {
    const lid = (await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P3.id, weekday: 3, subjectId: F.mth.id })).ok ? (await db.select().from(schema.timetableLessons).where(and(eq(schema.timetableLessons.classId, F.c1.id), eq(schema.timetableLessons.weekday, 3), eq(schema.timetableLessons.periodId, P3.id))))[0]!.id : 0; assert.ok(lid);
    await tt.removeLesson(GOLD, Number(lid)); assert.ok(!(await tt.loadTimetable(GOLD, F.sessionId, F.c1.id)).lessons.some((l) => l.id === Number(lid)));
    const a = (await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, F.schoolId), eq(schema.auditLog.action, 'timetable.lesson_removed'))))[0]!; assert.equal(Number(a.actorUserId), F.gold.u.id);
  });
  await check('every add and edit is audited with the person\'s id', async () => { const a = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, F.schoolId), eq(schema.auditLog.action, 'timetable.lesson_added'))); assert.ok(a.length >= 4 && a.every((x) => x.actorUserId)); });
  await check('removing a period that holds lessons is refused unless confirmed, and renaming one keeps its lessons', async () => {
    const keepAll = [{ name: 'Period 1', startTime: '08:00', endTime: '08:40' }, { name: 'Period 2', startTime: '08:40', endTime: '09:20' }, { name: 'Break', startTime: '09:20', endTime: '09:40', isBreak: true }];
    const r = await tt.savePeriods(P, keepAll); assert.ok(!r.ok && (r as { lessonsAffected?: number }).lessonsAffected! > 0 && fail(r).includes('Period 3'));
    const before = (await tt.loadTimetable(P, F.sessionId, F.c1.id)).lessons.length;
    const moved = [{ name: 'Period 1', startTime: '08:05', endTime: '08:45' }, { name: 'Period 2', startTime: '08:45', endTime: '09:20' }, { name: 'Break', startTime: '09:20', endTime: '09:40', isBreak: true }, { name: 'Period 3', startTime: '09:40', endTime: '10:20' }];
    assert.ok((await tt.savePeriods(P, moved)).ok); assert.equal((await tt.loadTimetable(P, F.sessionId, F.c1.id)).lessons.length, before, 're-timing a period keeps its lessons');
  });

  console.log('── publishing, and who sees a timetable ──');
  await check('a student or parent sees nothing until the class teacher publishes', async () => {
    for (const who of [SG, PG]) { const v = await tt.loadTimetable(who, F.sessionId, F.c1.id); assert.equal(v.lessons.length, 0); assert.equal(v.published, false); }
  });
  await check('an empty timetable cannot be published', async () => {
    const [empty] = await db.insert(schema.classes).values({ schoolId: F.schoolId, levelId: (await db.select().from(schema.classLevels).where(eq(schema.classLevels.schoolId, F.schoolId)))[0]!.id, displayName: 'JSS1 Empty', arm: 'Empty' }).returning();
    await rejects('empty', () => tt.setTimetablePublished(P, F.sessionId, empty!.id, true), 'at least one lesson');
  });
  await check('the class teacher publishes: that class\'s students and parents are notified once, nobody else', async () => {
    const r = await tt.setTimetablePublished(GOLD, F.sessionId, F.c1.id, true); assert.equal(r.notified, 2);
    assert.equal((await tt.setTimetablePublished(GOLD, F.sessionId, F.c1.id, true)).notified, 0, 'not twice');
    const n = await db.select().from(schema.notifications).where(and(eq(schema.notifications.schoolId, F.schoolId), eq(schema.notifications.type, 'calendar_event'))); const ids = n.map((x) => Number(x.userId)); assert.ok(ids.includes(F.sGold.u.id) && ids.includes(F.pu.id) && !ids.includes(F.sGreen.u.id));
  });
  await check('then the Gold student and parent see the timetable; the Green student does not see Gold\'s', async () => {
    assert.ok((await tt.loadTimetable(SG, F.sessionId)).lessons.length >= 3); assert.ok((await tt.loadTimetable(PG, F.sessionId)).lessons.length >= 3);
    const green = await tt.loadTimetable(SR, F.sessionId, F.c1.id); assert.ok(green.classId !== F.c1.id && !green.lessons.some((l) => l.classId === F.c1.id), 'cannot read another class');
  });
  await check('a student or parent still cannot edit a published timetable', async () => { assert.equal((await tt.loadTimetable(SG, F.sessionId)).canEdit, false); });
  await check('taking it back to a draft hides it from students again', async () => { await tt.setTimetablePublished(GOLD, F.sessionId, F.c1.id, false); assert.equal((await tt.loadTimetable(SG, F.sessionId)).lessons.length, 0); });
  await check('a DRAFT class timetable is visible only to those who build it: principal, exam officer and that class\'s teacher', async () => {
    for (const who of [P, EO, GOLD]) { const v = await tt.loadTimetable(who, F.sessionId, F.c1.id); assert.ok(v.lessons.length >= 3, 'a builder sees the draft'); assert.equal(v.published, false); }
  });
  await check('a subject teacher, another class teacher, a student and a parent see NOTHING of a draft, not even its lessons', async () => {
    for (const who of [MATHS, ENG, GREEN, SG, PG]) { const v = await tt.loadTimetable(who, F.sessionId, F.c1.id); assert.ok(!v.lessons.some((l) => l.classId === F.c1.id), 'draft lessons leaked'); assert.equal(v.todaysLessons.filter((l) => l.classId === F.c1.id).length, 0, 'draft lessons leaked into today'); }
  });
  await check('publishing it shows the lessons to the subject teacher of that class at once', async () => {
    await tt.setTimetablePublished(GOLD, F.sessionId, F.c1.id, true);
    assert.ok((await tt.loadTimetable(MATHS, F.sessionId, F.c1.id)).lessons.length >= 3); assert.equal((await tt.loadTimetable(MATHS, F.sessionId, F.c1.id)).canEdit, false);
    await tt.setTimetablePublished(GOLD, F.sessionId, F.c1.id, false);
  });

  console.log('── a teacher\'s own week ──');
  await check('a class teacher sees their own class\'s DRAFT lessons in their week (they build it); a subject teacher does not', async () => {
    // Gold is a draft right now. Put one Gold lesson on the Gold class teacher, then compare who sees it in their week.
    const P1 = (await tt.loadTimetable(P, F.sessionId)).periods.find((x) => !x.isBreak)!;
    const [extra] = await db.insert(schema.staffAssignments).values({ schoolId: F.schoolId, staffId: F.gold.s.id, classId: F.c1.id, assignmentType: 'subject_teacher', status: 'active', subjectId: F.mth.id } as never).returning();
    const r = await tt.saveLesson(GOLD, F.sessionId, { classId: F.c1.id, periodId: P1.id, weekday: 5, subjectId: F.mth.id, staffId: F.gold.s.id, room: 'Own' }); assert.ok(r.ok, fail(r));
    assert.ok((await tt.myTeachingWeek(GOLD, F.sessionId)).lessons.some((l) => l.classId === F.c1.id && l.room === 'Own'), 'the builder sees their own draft lesson');
    assert.ok(!(await tt.myTeachingWeek(MATHS, F.sessionId)).lessons.some((l) => l.room === 'Own'), 'a teacher of other lessons never sees it');
    await tt.removeLesson(GOLD, Number((r as { id: number }).id));
    await db.delete(schema.staffAssignments).where(eq(schema.staffAssignments.id, extra!.id));
  });
  await check('a timetable published in ANOTHER session never opens this session\'s draft', async () => {
    // Green is a draft this session. Publishing Green in an older session must not make its current lessons reach the Maths teacher.
    const [old] = await db.insert(schema.academicSessions).values({ schoolId: F.schoolId, title: '2025/26', isCurrent: false, startsOn: new Date('2025-09-01T00:00:00Z'), endsOn: new Date('2026-07-31T00:00:00Z') } as never).returning();
    await db.insert(schema.timetablePublication).values({ schoolId: F.schoolId, sessionId: old!.id, classId: F.c2.id, publishedBy: F.principal.id } as never);
    try {
      assert.ok(!(await tt.myTeachingWeek(MATHS, F.sessionId)).lessons.some((l) => l.classId === F.c2.id), 'another session\'s publication leaked into this one');
      assert.ok(!(await tt.loadTimetable(MATHS, F.sessionId, F.c2.id)).lessons.some((l) => l.classId === F.c2.id), 'and into the class view');
    } finally { await db.delete(schema.academicSessions).where(eq(schema.academicSessions.id, old!.id)); }
  });
  await check('a teacher\'s week holds only lessons from PUBLISHED class timetables (plus the class they build themselves); never anyone else\'s', async () => {
    // At this point Gold is back to a draft and Green was never published, so the Maths teacher (who builds neither) has no week yet.
    const draft = await tt.myTeachingWeek(MATHS, F.sessionId); assert.equal(draft.lessons.length, 0, 'unpublished lessons must not reach a subject teacher');
    await tt.setTimetablePublished(GOLD, F.sessionId, F.c1.id, true);
    const w = await tt.myTeachingWeek(MATHS, F.sessionId); assert.ok(w.lessons.length >= 1); assert.ok(w.lessons.every((l) => l.staffId === F.maths.s.id));
    assert.ok(w.lessons.every((l) => l.classId === F.c1.id), 'only the published class (Gold) shows; Green is still a draft');
    await tt.setTimetablePublished(GREEN, F.sessionId, F.c2.id, true);
    const both = await tt.myTeachingWeek(MATHS, F.sessionId); assert.ok(new Set(both.lessons.map((l) => l.className)).size === 2, 'once Green publishes, both classes show');
    const e = await tt.myTeachingWeek(ENG, F.sessionId); assert.ok(e.lessons.every((l) => l.staffId === F.eng.s.id));
  });

  console.log('── the timetable follows the academic calendar ──');
  await check('on a holiday, today\'s lessons are empty; on a normal teaching day they are not', async () => {
    const today = (await tt.loadTimetable(P, F.sessionId, F.c1.id)).today;
    await db.update(schema.terms).set({ startsOn: new Date(`${today}T00:00:00Z`), endsOn: new Date(new Date(today).getTime() + 30 * 86400000) }).where(eq(schema.terms.sessionId, F.sessionId));
    const wd = new Date(`${today}T00:00:00Z`).getUTCDay(), isWeekday = wd >= 1 && wd <= 5;
    if (isWeekday) {
      await db.insert(schema.timetableLessons).values({ schoolId: F.schoolId, sessionId: F.sessionId, classId: F.c1.id, periodId: P3.id, weekday: wd, subjectId: F.mth.id, staffId: null }).onConflictDoNothing();
      assert.ok((await tt.loadTimetable(P, F.sessionId, F.c1.id)).teachingToday, 'a school day inside term');
      const h = await cal.saveEvent(P, F.sessionId, { title: 'Today off', category: 'public_holiday', startsOn: today, endsOn: today, allDay: true, audience: 'everyone', status: 'scheduled', published: true }, undefined, true); void h;
      const off = await tt.loadTimetable(P, F.sessionId, F.c1.id); assert.equal(off.teachingToday, false); assert.equal(off.todaysLessons.length, 0, 'a public holiday empties the day');
    } else assert.equal((await tt.loadTimetable(P, F.sessionId, F.c1.id)).teachingToday, false, 'a weekend is not a teaching day');
  });

  console.log('── tenant isolation ──');
  await check('another school sees no periods or lessons, and cannot read, change or publish ours', async () => {
    const o = await tt.loadTimetable(PB, G.sessionId); assert.equal(o.lessons.length, 0); assert.equal(o.periods.length, 0);
    await rejects('their session', () => tt.saveLesson(PB, F.sessionId, { classId: G.c1.id, periodId: P1.id, weekday: 1, subjectId: G.mth.id }), 'session was not found');
    await rejects('remove ours', () => tt.removeLesson(PB, l1), 'not found'); await rejects('publish ours', () => tt.setTimetablePublished(PB, F.sessionId, F.c1.id, true), 'session was not found');
  });
  await check('RLS: a tenantless connection sees nothing, and school B\'s connection cannot read or change school A\'s lessons', async () => {
    const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, onnotice: () => {} });
    try { for (const t of ['timetable_periods', 'timetable_lessons', 'timetable_publication']) assert.equal((await app`select count(*)::int as n from ${app(t)}`)[0]!.n, 0, t); } finally { await app.end(); }
    const r = await forSchool(G.schoolId, async (tx) => ({ read: await tx.select().from(schema.timetableLessons).where(eq(schema.timetableLessons.schoolId, F.schoolId)), upd: await tx.update(schema.timetableLessons).set({ room: 'pwned' }).where(eq(schema.timetableLessons.schoolId, F.schoolId)).returning() }));
    assert.equal(r.read.length, 0); assert.equal(r.upd.length, 0);
  });

  console.log(`\nTIMETABLE OK: ${count} checks passed.`);
  await appSingleton.end().catch(() => {});
  await owner.end();
}

main().catch(async (err) => { console.error(err); process.exitCode = 1; });
