/**
 * A practice paper can be open for a limited time. The exam officer sets the window; students see the paper only
 * once it is published; a new attempt outside the window is refused; someone already sitting can finish.
 * Isolated fixture school, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { createSeries, composeSeries, publishSeries, setPracticeWindow } = await import('@/lib/exam/compose');
  const { startAttempt } = await import('@/lib/exam/engine');
  const { practicePapersFor } = await import('@/lib/exam/practice');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const ids: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  const DAY = 86400000;

  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Practice window', code: 'PW-' + randomUUID() }).returning();
    const schoolId = school!.id; ids.push(schoolId);
    const mkUser = async (role: 'exam_officer' | 'teacher', login: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: login, firstName: 'T', lastName: login }).returning();
      return { schoolId, userId: user!.id, role, staffId: staff!.id, studentId: null, loginId: login } as Actor;
    };
    const officer = await mkUser('exam_officer', 'officer'), teacher = await mkUser('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS2', stage: 'senior' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS2 A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    const [student] = await db.insert(schema.students).values({ schoolId, admissionNumber: 'A' + randomUUID().slice(0, 6), firstName: 'S', lastName: 'T', classId: room!.id } as never).returning();
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id, termId: term!.id } as never);
    const series = await createSeries(officer, { title: 'WAEC English practice', seriesType: 'practice', sessionId: session!.id, termId: term!.id, questionsPerStudent: 2, durationMinutes: 30 });
    const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id,
      examType: 'objective', seriesId: Number(series.id), status: 'approved', teacherId: teacher.staffId!, waecMode: true }).returning();
    for (let i = 0; i < 3; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: `Practice question ${i}?`, sequence: i + 1, approvalStatus: 'approved' }).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
    }
    await composeSeries(officer, Number(series.id));
    const [paper] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(series.id)));
    return { schoolId, officer, teacher, series, paperId: Number(paper!.id), studentId: Number(student!.id) };
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const listed = (f: { schoolId: number; studentId: number }) => practicePapersFor(f.schoolId, f.studentId);

  try {
    await check('a practice paper nobody has published is invisible to students and cannot be started', async () => {
      const f = await fixture();
      assert.equal((await listed(f)).length, 0);
      const r = await startAttempt(f.schoolId, f.paperId, f.studentId);
      assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, 'not_published');
    });
    await check('once published, with no window set, it is open as it always was', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      const rows = await listed(f); assert.equal(rows.length, 1);
      assert.equal(rows[0]!.opensAt, null); assert.equal(rows[0]!.closesAt, null); assert.equal(rows[0]!.windowState, 'open');
      assert.equal((await startAttempt(f.schoolId, f.paperId, f.studentId)).ok, true);
    });
    await check('the officer can open a practice paper for a limited time', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: iso(Date.now() - DAY), closesAt: iso(Date.now() + DAY) });
      const rows = await listed(f);
      assert.equal(rows[0]!.windowState, 'open'); assert.ok(rows[0]!.closesAt); assert.ok(rows[0]!.opensAt);
      assert.equal((await startAttempt(f.schoolId, f.paperId, f.studentId)).ok, true);
    });
    await check('before the window opens a new attempt is refused, and the list says when it opens', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: iso(Date.now() + DAY), closesAt: iso(Date.now() + 2 * DAY) });
      assert.equal((await listed(f))[0]!.windowState, 'not_open');
      const r = await startAttempt(f.schoolId, f.paperId, f.studentId); assert.equal((r as { reason: string }).reason, 'practice_not_open');
    });
    await check('after the window closes a new attempt is refused, and the list marks it closed', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: iso(Date.now() - 3 * DAY), closesAt: iso(Date.now() - DAY) });
      assert.equal((await listed(f))[0]!.windowState, 'closed');
      const r = await startAttempt(f.schoolId, f.paperId, f.studentId); assert.equal((r as { reason: string }).reason, 'practice_closed');
      assert.equal((await db.select().from(schema.attempts).where(eq(schema.attempts.paperId, f.paperId))).length, 0, 'no attempt was created');
    });
    await check('a student who is already sitting can resume after the window closes', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      const first = await startAttempt(f.schoolId, f.paperId, f.studentId); assert.equal(first.ok, true);
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: iso(Date.now() - 3 * DAY), closesAt: iso(Date.now() - 1000) });
      const again = await startAttempt(f.schoolId, f.paperId, f.studentId);
      assert.equal(again.ok, true); assert.equal((again as { resumed: boolean }).resumed, true);
    });
    await check('only an open-ended or a sensible window is accepted: closing before opening is refused', async () => {
      const f = await fixture();
      await assert.rejects(setPracticeWindow(f.officer, Number(f.series.id), { opensAt: iso(Date.now() + 2 * DAY), closesAt: iso(Date.now() + DAY) }), /close after/i);
      await assert.rejects(setPracticeWindow(f.officer, Number(f.series.id), { opensAt: 'not a date', closesAt: iso(Date.now() + DAY) }), /valid date/i);
    });
    await check('a window can be open-ended at either end, and can be cleared again', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: null, closesAt: iso(Date.now() + DAY) });
      assert.equal((await listed(f))[0]!.windowState, 'open');
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: null, closesAt: null });
      const r = (await listed(f))[0]!; assert.equal(r.opensAt, null); assert.equal(r.closesAt, null);
    });
    await check('the window is only for practice: an examination or CA test cannot be given one this way', async () => {
      const f = await fixture();
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      const exam = await createSeries(f.officer, { title: 'First Term Exam', seriesType: 'examination', sessionId: session!.id, termId: term!.id, questionsPerStudent: 2, durationMinutes: 30 });
      await assert.rejects(setPracticeWindow(f.officer, Number(exam.id), { opensAt: null, closesAt: iso(Date.now() + DAY) }), /only for practice/i);
    });
    await check('a teacher cannot set the window; only the exam office can', async () => {
      const f = await fixture();
      await assert.rejects(setPracticeWindow(f.teacher, Number(f.series.id), { opensAt: null, closesAt: iso(Date.now() + DAY) }));
    });
    await check('another school\'s practice series cannot be changed', async () => {
      const f = await fixture(), g = await fixture();
      await assert.rejects(setPracticeWindow(g.officer, Number(f.series.id), { opensAt: null, closesAt: iso(Date.now() + DAY) }), /not found/i);
    });
    await check('the change is written to the audit trail', async () => {
      const f = await fixture();
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: null, closesAt: iso(Date.now() + DAY) });
      assert.ok((await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, f.schoolId))).some((r) => r.action === 'exam_series.practice_window'));
    });
    await check('a practice window never puts the practice paper on the academic calendar or in the timetable', async () => {
      const f = await fixture(); await publishSeries(f.officer, Number(f.series.id));
      await setPracticeWindow(f.officer, Number(f.series.id), { opensAt: iso(Date.now() - DAY), closesAt: iso(Date.now() + DAY) });
      const { forSchool } = await import('@/db');
      const { examEntries } = await import('@/lib/calendar/service');
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const entries = await forSchool(f.schoolId, (tx) => examEntries(tx, f.schoolId, Number(session!.id), 'Africa/Lagos'));
      assert.equal(entries.filter((e) => e.id === Number(f.series.id)).length, 0, 'practice is not a calendar exam');
    });
    await check('a formal examination is still bound to its timetable window, exactly as before', async () => {
      const f = await fixture();
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      const exam = await createSeries(f.officer, { title: 'Sat exam', seriesType: 'examination', sessionId: session!.id, termId: term!.id, questionsPerStudent: 2, durationMinutes: 30 });
      const [paper] = await db.insert(schema.examPapers).values({ schoolId: f.schoolId, seriesId: Number(exam.id), subjectId: (await db.select().from(schema.subjects).where(eq(schema.subjects.schoolId, f.schoolId)))[0]!.id,
        durationSeconds: 600, questionCount: 1, status: 'published' } as never).returning();
      const r = await startAttempt(f.schoolId, Number(paper!.id), f.studentId);
      assert.equal(r.ok, false); assert.equal((r as { reason: string }).reason, 'not_scheduled');
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (ids.length) await db.delete(schema.schools).where(eq(schema.schools.id, ids[0]!));
    for (const id of ids.slice(1)) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
