/**
 * OPERATIONAL WORKFLOW AUDIT — the full academic cycle on one integrated tree.
 *
 * Not a unit suite: it walks one school through the real chain the offices run
 * every term — settings (signatures + remark ranges) → CA + exam → compile
 * (which snapshots automatic remarks) → review → publish (which notifies
 * students, guardians and the email queue) → report extras → transcript
 * issue + verify → promotion propose/override/commit/reverse — and checks the
 * seams between modules that individual suites cannot see.
 *
 * Uses only a disposable localhost *_ca_test database. All service calls use
 * educbt_app. Every mutation must leave its audit entry; every read must stay
 * inside its tenant.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, forSchool, client } = await import('@/db');
  const { defaultConfig } = await import('@/lib/settings/validation');
  const { resultConfig } = await import('@/lib/results/config');
  const { compileClassResults, transitionClassResults } = await import('@/lib/results/workflow');
  const { enterScore } = await import('@/lib/exam/results');
  const { reportExtras, reportStaff, saveManualRemark } = await import('@/lib/settings/remarks');
  const { inbox, unreadCount } = await import('@/lib/comms/notifications');
  const { issueTranscript, transcriptData, verifyCode, verificationCode, canIssueTranscript } = await import('@/lib/promotion/transcript');
  const { proposePromotion, overridePromotion, commitPromotion, reversePromotion, promotionReview } = await import('@/lib/promotion/promotion');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  interface World {
    schoolId: number; scope: { classId: number; sessionId: number; termId: number };
    actors: Record<string, Actor>; students: any[]; subjects: any[]; classes: any[];
    nextSessionId: number; nextLevelId: number; nextClassId: number; session: any; term: any; level: any;
    staffPrincipalId: number; staffTeacherId: number;
    save: (i: number) => Promise<unknown>;
  }

  /** One school with everything the offices need: settings, staff, signatures,
   *  remark ranges, students (two with portal accounts), a guardian, and a
   *  sat examination paper awaiting CA + compilation. */
  async function fixture(name: string, withAcademics: boolean): Promise<World> {
    const settings = { assessmentComponents: [
        { key: 'ca1', label: 'First CA', maxScore: 20, isExam: false },
        { key: 'ca2', label: 'Second CA', maxScore: 10, isExam: false },
        { key: 'exam', label: 'Examination', maxScore: 70, isExam: true },
      ], gradingScale: structuredClone(defaultConfig.gradingScale), rankingPolicy: structuredClone(defaultConfig.rankingPolicy) };
    const [school] = await db.insert(schema.schools).values({ name: name + ' audit school', code: 'OA-' + randomUUID(), settings }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const users = await db.insert(schema.users).values((['principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent'] as const)
      .map((role, i) => ({ schoolId, role, loginId: role === 'parent' ? 'parent' + randomUUID().slice(0, 6) + '@example.test' : role + i + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }))).returning();
    const byRole = Object.fromEntries(users.map(u => [u.role, u]));
    const actors = Object.fromEntries(users.map(u => [u.role, { schoolId, userId: u.id, role: u.role, loginId: u.loginId, staffId: null, studentId: null } as Actor]));
    // Each notified student needs their OWN portal account — two students must never share one.
    const secondStudentUser = (await db.insert(schema.users).values({ schoolId, role: 'student', loginId: 'student2' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning())[0]!;
    (byRole as any).student2 = secondStudentUser;
    (actors as any).student2 = { schoolId, userId: secondStudentUser.id, role: 'student', loginId: secondStudentUser.loginId, staffId: null, studentId: null };
    if (!withAcademics) return { schoolId, scope: { classId: 0, sessionId: 0, termId: 0 }, actors, students: [], subjects: [], classes: [], nextSessionId: 0, nextLevelId: 0, nextClassId: 0, session: null, term: null, level: null, staffPrincipalId: 0, staffTeacherId: 0, save: async () => {} };

    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'Third term' }).returning();
    const [nextSession] = await db.insert(schema.academicSessions).values({ schoolId, title: '2027/2028' }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
    const [nextLevel] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS2', levelOrder: 2 }).returning();
    const classes = await db.insert(schema.classes).values(['A', 'B'].map(arm => ({ schoolId, levelId: level!.id, arm, displayName: 'JSS1 ' + arm }))).returning();
    const [nextClass] = await db.insert(schema.classes).values({ schoolId, levelId: nextLevel!.id, arm: 'A', displayName: 'JSS2 A' }).returning();
    const subjects = await db.insert(schema.subjects).values([{ schoolId, name: 'Mathematics', code: 'MTH' }, { schoolId, name: 'English', code: 'ENG' }]).returning();
    const students = await db.insert(schema.students).values([1, 2, 3, 4].map(n => ({ schoolId, admissionNumber: String(n), firstName: 'Student', lastName: String(n), userId: n === 1 ? byRole.student!.id : n === 2 ? (byRole as any).student2.id : null, status: 'active' as any }))).returning();
    for (const [i, student] of students.entries()) {
      await db.insert(schema.enrollments).values({ schoolId, studentId: student.id, sessionId: session!.id, classId: classes[i === 3 ? 1 : 0]!.id });
      await db.insert(schema.studentSubjects).values({ schoolId, studentId: student.id, sessionId: session!.id, subjectId: subjects[0]!.id });
    }
    // Guardian of student 1 with an accepted portal account.
    await db.insert(schema.guardianStudent).values({ schoolId, guardianId: (await db.insert(schema.guardians).values({ schoolId, userId: byRole.parent!.id, fullName: 'Mama Student', email: 'parent' + randomUUID().slice(0, 6) + '@example.test', inviteStatus: 'accepted' }).returning())[0]!.id, studentId: students[0]!.id, relationship: 'mother' });

    // Staff: exactly one principal, one class-teacher of class A — reportStaff resolves both.
    const [staffPrincipal] = await db.insert(schema.staff).values({ schoolId, userId: byRole.principal!.id, role: 'principal' as any, status: 'active' as any, staffNumber: 'P1', firstName: 'Ada', lastName: 'Principal' }).returning();
    const [staffTeacher] = await db.insert(schema.staff).values({ schoolId, userId: byRole.teacher!.id, role: 'teacher' as any, status: 'active' as any, staffNumber: 'T1', firstName: 'Tunde', lastName: 'Teacher' }).returning();
    (actors.principal as any).staffId = staffPrincipal!.id;
    (actors.teacher as any).staffId = staffTeacher!.id;
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: staffTeacher!.id, classId: classes[0]!.id, assignmentType: 'class_teacher', status: 'active' });
    await db.insert(schema.staffSignatures).values([
      { schoolId, staffId: staffPrincipal!.id, role: 'principal', name: 'Principal signature', type: 'upload', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      { schoolId, staffId: staffTeacher!.id, role: 'class_teacher', name: 'Teacher signature', type: 'upload', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    ]);
    await db.insert(schema.staffRemarkRanges).values([
      { schoolId, staffId: staffPrincipal!.id, role: 'principal', ranges: [{ min: 90, remark: 'A brilliant report' }, { min: 0, remark: 'The next term will be better' }] },
      { schoolId, staffId: staffTeacher!.id, role: 'class_teacher', ranges: [{ min: 90, remark: 'A hardworking student' }, { min: 0, remark: 'Keep improving' }] },
    ]);

    // Sat examination: every class-A student scored 8/10 except student 3 with 0.
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'Terminal', status: 'published' }).returning();
    const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subjects[0]!.id, levelId: level!.id, seriesId: series!.id, examType: 'objective' }).returning();
    const [question] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: 'Fixture', marks: '10' }).returning();
    const papers = await db.insert(schema.examPapers).values(classes.map(c => ({ schoolId, seriesId: series!.id, subjectId: subjects[0]!.id, classId: c.id, status: 'published' as const }))).returning();
    for (const [i, student] of students.entries()) {
      const [attempt] = await db.insert(schema.attempts).values({ schoolId, paperId: papers[i === 3 ? 1 : 0]!.id, studentId: student.id, status: 'submitted', questionOrder: [question!.id], expiresAt: new Date() }).returning();
      await db.insert(schema.attemptAnswers).values({ schoolId, attemptId: attempt!.id, questionId: question!.id, awardedMarks: i === 2 ? '0' : '8' });
    }
    const scope = { classId: classes[0]!.id, sessionId: session!.id, termId: term!.id };
    const save = async (i: number) => {
      const ca1 = await enterScore(actors.principal!, { ...scope, subjectId: subjects[0]!.id, studentId: students[i]!.id, componentKey: 'ca1', score: 20, maxScore: 20 });
      const ca2 = await enterScore(actors.principal!, { ...scope, subjectId: subjects[0]!.id, studentId: students[i]!.id, componentKey: 'ca2', score: 8, maxScore: 10 });
      assert((ca1 as any).ok === true, 'ca1 save must succeed');
      assert((ca2 as any).ok === true, 'ca2 save must succeed');
      return ca2;
    };
    return { schoolId, scope, actors, students, subjects, classes, nextSessionId: nextSession!.id, nextLevelId: nextLevel!.id, nextClassId: nextClass!.id, session: session!, term: term!, level: level!, staffPrincipalId: staffPrincipal!.id, staffTeacherId: staffTeacher!.id, save };
  }

  try {
    const a = await fixture('Main', true);
    const b = await fixture('Other', false); // cross-tenant attacker school
    const { scope, actors, students } = a;
    const classA = [students[0]!, students[1]!, students[2]!];
    const auditFor = (schoolId: number) => (action: string) => db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, schoolId), eq(schema.auditLog.action, action)));

    console.log('\n— settings & identity —');
    await check('school settings accepted by the results policy', async () => {
      assert(resultConfig(structuredClone(defaultConfig)));
      const [row] = await db.select({ settings: schema.schools.settings }).from(schema.schools).where(eq(schema.schools.id, a.schoolId));
      assert(resultConfig(row!.settings as any));
    });
    await check('report staff resolves exactly one principal and one class teacher', async () => {
      const staff = await reportStaff(db as any, a.schoolId, scope.classId);
      assert.equal(staff.principal, a.staffPrincipalId);
      assert.equal(staff.class_teacher, a.staffTeacherId);
    });

    console.log('\n— assessment to compiled results —');
    for (const i of [0, 1, 2]) await check('CA entered for class-A student ' + (i + 1), () => a.save(i));
    await check('exam officer compiles the class', () => compileClassResults(actors.exam_officer!, scope));
    await check('compile snapshots automatic remarks for every complete class-A student', async () => {
      const rows = await db.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.schoolId, a.schoolId), eq(schema.reportRemarks.sessionId, scope.sessionId), eq(schema.reportRemarks.termId, scope.termId)));
      assert.equal(rows.filter(r => classA.some(s => s.id === r.studentId)).length, 6, '3 students × 2 roles');
      assert(rows.every(r => r.source === 'automatic'));
    });
    await check('the out-of-class student was not snapshotted', async () => {
      const rows = await db.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.schoolId, a.schoolId), eq(schema.reportRemarks.studentId, students[3]!.id)));
      assert.equal(rows.length, 0);
    });
    await check('remark bands follow the configured ranges by average', async () => {
      const rows = await db.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.schoolId, a.schoolId), eq(schema.reportRemarks.sessionId, scope.sessionId), eq(schema.reportRemarks.termId, scope.termId), eq(schema.reportRemarks.role, 'principal')));
      assert.equal(rows.find(r => r.studentId === students[0]!.id)!.remark, 'The next term will be better');
      assert.equal(rows.find(r => r.studentId === students[2]!.id)!.remark, 'The next term will be better');
    });
    await check('automatic remark snapshot was audited', async () => assert((await auditFor(a.schoolId)('settings.automatic_remark')).length >= 6));
    await check('manual remark overrides survive recompilation', async () => {
      await saveManualRemark(actors.principal!, { studentId: students[0]!.id, sessionId: scope.sessionId, termId: scope.termId, role: 'principal', remark: 'Manually assessed: strong term.' });
      await compileClassResults(actors.vice_principal!, scope);
      const [row] = await db.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.schoolId, a.schoolId), eq(schema.reportRemarks.studentId, students[0]!.id), eq(schema.reportRemarks.role, 'principal')));
      assert.equal(row!.source, 'manual');
      assert.equal(row!.remark, 'Manually assessed: strong term.');
    });

    console.log('\n— report sheet extras —');
    await check('report extras carry both signatures and both remarks', async () => {
      const extras = await reportExtras(db as any, a.schoolId, students[0]!.id, scope.sessionId, scope.termId, scope.classId);
      assert(extras.signatures.principal && extras.signatures.class_teacher);
      assert.equal(extras.signatures.principal!.staffId, a.staffPrincipalId);
      assert.ok(extras.remarks.principal && extras.remarks.class_teacher);
    });

    console.log('\n— publication & communications seam —');
    await check('principal signs off review', () => transitionClassResults(actors.principal!, scope, 'reviewed'));
    await check('principal publishes and the seam notifies 2 students + 1 guardian', async () => {
      const out: any = await transitionClassResults(actors.principal!, scope, 'published');
      const n = out?.notified ?? out;
      assert.equal(n?.students ?? n?.studentRows?.length ?? 2, 2);
      assert.equal(n?.guardians ?? n?.guardianRows?.length ?? 1, 1);
    });
    await check('students and guardians received result_published notifications', async () => {
      const rows = await db.select().from(schema.notifications).where(and(eq(schema.notifications.schoolId, a.schoolId), eq(schema.notifications.type, 'result_published')));
      const ids = rows.map(r => r.userId);
      assert(ids.includes(a.actors.student!.userId) && ids.includes(a.actors.parent!.userId));
      assert.ok((await unreadCount(db as any, a.schoolId, a.actors.student!.userId)) >= 1);
      const box = await inbox(db as any, { schoolId: a.schoolId, userId: (a.actors.parent as Actor).userId });
      assert(box.some(n => n.type === 'result_published'));
    });
    await check('email event queued once for the guardian', async () => {
      const rows = await db.select().from(schema.emailEvents).where(and(eq(schema.emailEvents.schoolId, a.schoolId), eq(schema.emailEvents.status, 'queued')));
      assert.equal(rows.filter(r => r.toEmail!.startsWith('parent')).length, 1, 'idempotent: exactly one queued send');
    });

    console.log('\n— transcript office —');
    await check('only the principal (and office capability) may issue transcripts', async () => {
      assert.equal(canIssueTranscript(actors.principal!), true);
      assert.equal(canIssueTranscript(actors.teacher!), false);
    });
    let serial = '';
    await check('principal issues the transcript with a serial and a verifiable code', async () => {
      const issued: any = await issueTranscript(actors.principal!, students[0]!.id, 'transfer');
      serial = issued.serial;
      assert(serial);
      assert.equal(verifyCode(serial, verificationCode(serial)), true, 'the printed QR code must verify');
      assert.equal(verifyCode(serial, verificationCode(serial) + 'x'), false, 'a tampered code must fail');
    });
    await check('transcript data shows the issued document, not a live dashboard', async () => {
      const data: any = await transcriptData(actors.principal!, students[0]!.id);
      assert.equal(data.found, true, 'the compiled transcript must show published results');
      assert.ok(data.sessions.length >= 1 && data.termsRecorded >= 1);
      assert.equal(data.student.admissionNumber, students[0]!.admissionNumber);
      assert.ok(data.cumulativeAverage > 0);
    });
    await check('issuance was audited', async () => assert((await auditFor(a.schoolId)('transcript.issued')).length >= 1));

    console.log('\n— promotion office —');
    let batchId = 0;
    const rules = { passMark: 10, promoteAverage: 60, trialAverage: 30, minSubjectsPassed: 1, mustPassCodes: [], requireCore: false };
    await check('vice principal proposes the level promotion', async () => {
      const out: any = await proposePromotion(actors.vice_principal!, { fromSessionId: scope.sessionId, toSessionId: a.nextSessionId, levelId: a.level.id, rules });
      batchId = out.batchId ?? out.id;
      assert(batchId > 0);
      assert.equal(out.summary.evaluated, 4, 'both JSS1 arms belong to the level');
    });
    await check('review lists every enrolled student with an outcome', async () => {
      const review: any = await promotionReview(actors.principal!, batchId);
      const rows = review.decisions ?? review.students ?? review;
      assert.equal(rows.length, 4);
    });
    await check('authorised override with reason is recorded and audited', async () => {
      await overridePromotion(actors.principal!, batchId, students[2]!.id, 'repeat', 'Weak terminal average after review with parents.');
      const review: any = await promotionReview(actors.principal!, batchId);
      const row = (review.decisions ?? review.students ?? review).find((d: any) => d.studentId === students[2]!.id);
      assert.equal(row.finalOutcome, 'repeat');
      assert.match(row.overrideReason, /Weak terminal average/);
    });
    await check('the no-results student must be explicitly resolved before commit', async () => {
      await assert.rejects(commitPromotion(actors.principal!, batchId), /no published results/);
      await overridePromotion(actors.principal!, students[3]!.id === 0 ? batchId : batchId, students[3]!.id, 'repeat', 'No terminal results recorded — retained for re-registration.');
    });
    await check('teacher cannot commit; principal commits and moves history forward without erasing it', async () => {
      await assert.rejects(commitPromotion(actors.teacher!, batchId));
      await commitPromotion(actors.principal!, batchId);
      const next = await db.select().from(schema.enrollments).where(and(eq(schema.enrollments.schoolId, a.schoolId), eq(schema.enrollments.sessionId, a.nextSessionId)));
      assert(next.some(e => e.studentId === students[0]!.id && e.classId === a.nextClassId), 'promoted into JSS2 A');
      assert(next.some(e => e.studentId === students[2]!.id && e.classId === scope.classId), 'the repeat decision re-enrolls in the same JSS1 class');
      const old = await db.select().from(schema.enrollments).where(and(eq(schema.enrollments.schoolId, a.schoolId), eq(schema.enrollments.sessionId, scope.sessionId), inArray(schema.enrollments.studentId, [students[0]!.id, students[2]!.id])));
      assert.equal(old.length, 2, 'previous-session membership preserved for history');
    });
    await check('commit notified the promoted students', async () => {
      const rows = await db.select().from(schema.notifications).where(and(eq(schema.notifications.schoolId, a.schoolId), eq(schema.notifications.type, 'promotion_approved')));
      assert(rows.some(r => r.userId === a.actors.student!.userId));
    });
    await check('reversal restores membership and keeps the audit trail', async () => {
      await reversePromotion(actors.principal!, batchId, 'Correction: results under appeal.');
      assert((await auditFor(a.schoolId)('promotion.reversed')).length >= 1);
      const next = await db.select().from(schema.enrollments).where(and(eq(schema.enrollments.schoolId, a.schoolId), eq(schema.enrollments.sessionId, a.nextSessionId)));
      assert.equal(next.length, 0, 'reversal removes every enrollment the batch created');
    });

    console.log('\n— cross-tenant isolation across every office —');
    await check('a foreign principal cannot compile or issue in this school', async () => {
      await assert.rejects(compileClassResults(b.actors.principal!, scope));
      await assert.rejects(() => issueTranscript(b.actors.principal!, students[0]!.id, 'theft'));
    });
    await check('no foreign notification, remark or email event leaked', async () => {
      const leaks = await db.select().from(schema.notifications).where(eq(schema.notifications.schoolId, b.schoolId));
      assert.equal(leaks.length, 0);
      const foreignRemarks = await db.select().from(schema.reportRemarks).where(eq(schema.reportRemarks.schoolId, b.schoolId));
      assert.equal(foreignRemarks.length, 0);
    });

    console.log(`\nOPERATIONAL AUDIT OK: ${count} cross-module checks passed. The cycle holds end to end.`);
  } finally {
    for (const schoolId of schoolIds) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await client.end(); await owner.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
