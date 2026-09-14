/**
 * ROLE COMPLETENESS (Phase 6) — every role can do its whole job, and nothing
 * outside it.
 *
 * A targeted matrix over the real service gates: for each of the platform's
 * roles, walk its complete office workflow and assert it succeeds, then assert
 * the roles that must NOT reach that workflow are refused. Completeness is the
 * point as much as denial: a teacher locked out of their own class, or a
 * parent who cannot see an only child's report, is a parity failure even when
 * every denial test passes.
 *
 * Uses only a disposable localhost *_ca_test database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  // The QR verification check signs AND verifies with this secret; without it
  // the suite fails confusingly at "the printed QR code must verify" instead
  // of telling you why (test-promotion guards the same way).
  assert(process.env.TRANSCRIPT_VERIFY_SECRET, 'Role tests require TRANSCRIPT_VERIFY_SECRET in the environment.');
  const { schema } = await import('@/db');
  const { defaultConfig } = await import('@/lib/settings/validation');
  const { compileClassResults, transitionClassResults } = await import('@/lib/results/workflow');
  const { enterScore } = await import('@/lib/exam/results');
  const { saveManualRemark } = await import('@/lib/settings/remarks');
  const { saveRanges } = await import('@/lib/settings/service');
  const { forSchool, client: appSingleton } = await import('@/db');
  const { reportAudience } = await import('@/lib/results/report-access');
  const { allowedAudiences, assertCanCreate, ANNOUNCEMENT_AUDIENCES } = await import('@/lib/comms/announcements');
  const { canIssueTranscript, issueTranscript, verificationCode, verifyCode } = await import('@/lib/promotion/transcript');
  const { proposePromotion, commitPromotion } = await import('@/lib/promotion/promotion');
  const { inbox } = await import('@/lib/comms/notifications');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  // ── Fixture ────────────────────────────────────────────────────────────────
  const settings = { assessmentComponents: [
      { key: 'ca1', label: 'First CA', maxScore: 20, isExam: false },
      { key: 'ca2', label: 'Second CA', maxScore: 10, isExam: false },
      { key: 'exam', label: 'Examination', maxScore: 70, isExam: true },
    ], gradingScale: structuredClone(defaultConfig.gradingScale), rankingPolicy: structuredClone(defaultConfig.rankingPolicy) };
  const [school] = await db.insert(schema.schools).values({ name: 'Role completeness school', code: 'RC-' + randomUUID(), settings }).returning();
  const schoolId = school!.id;
  const roles = ['principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent'] as const;
  const users = await db.insert(schema.users).values(roles.map((role, i) => ({ schoolId, role, loginId: role === 'parent' ? 'parent' + randomUUID().slice(0, 6) + '@example.test' : role + i + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }))).returning();
  const byRole: Record<string, any> = Object.fromEntries(users.map(u => [u.role, u]));
  const actors: Record<string, Actor> = Object.fromEntries(users.map(u => [u.role, { schoolId, userId: u.id, role: u.role, loginId: u.loginId, staffId: null, studentId: null } as Actor]));
  // A second teacher with NO class assignment — the completeness counter-case.
  const plainTeacherUser = (await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 'plain' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning())[0]!;
  actors.plain_teacher = { schoolId, userId: plainTeacherUser.id, role: 'teacher', loginId: plainTeacherUser.loginId, staffId: null, studentId: null };
  // A second student with their own account.
  const student2User = (await db.insert(schema.users).values({ schoolId, role: 'student', loginId: 'student2' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning())[0]!;
  actors.student2 = { schoolId, userId: student2User.id, role: 'student', loginId: student2User.loginId, staffId: null, studentId: null };

  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
  const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First term' }).returning();
  const [nextSession] = await db.insert(schema.academicSessions).values({ schoolId, title: '2027/2028' }).returning();
  const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
  const [nextLevel] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS2', levelOrder: 2 }).returning();
  const classes = await db.insert(schema.classes).values(['A', 'B'].map(arm => ({ schoolId, levelId: level!.id, arm, displayName: 'JSS1 ' + arm }))).returning();
  const [nextClass] = await db.insert(schema.classes).values({ schoolId, levelId: nextLevel!.id, arm: 'A', displayName: 'JSS2 A' }).returning();
  const [subject] = await db.insert(schema.subjects).values({ schoolId, name: 'Mathematics', code: 'MTH' }).returning();
  const students = await db.insert(schema.students).values([1, 2].map(n => ({ schoolId, admissionNumber: String(n), firstName: 'Student', lastName: String(n), userId: n === 1 ? byRole.student!.id : student2User.id, status: 'active' as any }))).returning();
  for (const [i, student] of students.entries()) {
    await db.insert(schema.enrollments).values({ schoolId, studentId: student.id, sessionId: session!.id, classId: classes[i]!.id });
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: student.id, sessionId: session!.id, subjectId: subject!.id });
  }
  // Parent is the accepted guardian of student 1 only.
  await db.insert(schema.guardianStudent).values({ schoolId, guardianId: (await db.insert(schema.guardians).values({ schoolId, userId: byRole.parent!.id, fullName: 'Mama Student', email: 'parent' + randomUUID().slice(0, 6) + '@example.test', inviteStatus: 'accepted' }).returning())[0]!.id, studentId: students[0]!.id, relationship: 'mother', canViewResults: true });

  // Staff: principal + class teacher of A + an unassigned plain teacher.
  const [staffPrincipal] = await db.insert(schema.staff).values({ schoolId, userId: byRole.principal!.id, role: 'principal' as any, status: 'active' as any, staffNumber: 'P1', firstName: 'Ada', lastName: 'Principal' }).returning();
  const [staffTeacher] = await db.insert(schema.staff).values({ schoolId, userId: byRole.teacher!.id, role: 'teacher' as any, status: 'active' as any, staffNumber: 'T1', firstName: 'Tunde', lastName: 'Teacher' }).returning();
  const [staffPlain] = await db.insert(schema.staff).values({ schoolId, userId: plainTeacherUser.id, role: 'teacher' as any, status: 'active' as any, staffNumber: 'T2', firstName: 'Bola', lastName: 'Unassigned' }).returning();
  (actors.principal as any).staffId = staffPrincipal!.id;
  (actors.teacher as any).staffId = staffTeacher!.id;
  (actors.plain_teacher as any).staffId = staffPlain!.id;
  await db.insert(schema.staffAssignments).values({ schoolId, staffId: staffTeacher!.id, classId: classes[0]!.id, assignmentType: 'class_teacher', status: 'active' });
  await db.insert(schema.staffAssignments).values({ schoolId, staffId: staffTeacher!.id, classId: classes[0]!.id, subjectId: subject!.id, assignmentType: 'subject_teacher', status: 'active' });
  await db.insert(schema.staffSignatures).values([
    { schoolId, staffId: staffPrincipal!.id, role: 'principal', name: 'Principal signature', type: 'upload', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
    { schoolId, staffId: staffTeacher!.id, role: 'class_teacher', name: 'Teacher signature', type: 'upload', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
  ]);
  await db.insert(schema.staffRemarkRanges).values([
    { schoolId, staffId: staffPrincipal!.id, role: 'principal', ranges: [{ min: 90, remark: 'A brilliant report' }, { min: 0, remark: 'The next term will be better' }] },
    { schoolId, staffId: staffTeacher!.id, role: 'class_teacher', ranges: [{ min: 90, remark: 'A hardworking student' }, { min: 0, remark: 'Keep improving' }] },
  ]);

  // Sat examination paper with scores, so compilation has real inputs.
  const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'Terminal', status: 'published' }).returning();
  const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, seriesId: series!.id, examType: 'objective' }).returning();
  const [question] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: 'Fixture', marks: '10' }).returning();
  const papers = await db.insert(schema.examPapers).values(classes.map(c => ({ schoolId, seriesId: series!.id, subjectId: subject!.id, classId: c.id, status: 'published' as const }))).returning();
  for (const [i, student] of students.entries()) {
    const [attempt] = await db.insert(schema.attempts).values({ schoolId, paperId: papers[i]!.id, studentId: student.id, status: 'submitted' as const, questionOrder: [question!.id], expiresAt: new Date() }).returning();
    await db.insert(schema.attemptAnswers).values({ schoolId, attemptId: attempt!.id, questionId: question!.id, awardedMarks: '8' });
  }
  const scopeA = { classId: classes[0]!.id, sessionId: session!.id, termId: term!.id };
  const scopeB = { classId: classes[1]!.id, sessionId: session!.id, termId: term!.id };
  const ca = (actor: Actor, i: number, scope: any, key = 'ca1') => enterScore(actor, { ...scope, subjectId: subject!.id, studentId: students[i]!.id, componentKey: key, score: key === 'ca1' ? 20 : 8, maxScore: key === 'ca1' ? 20 : 10 });

  try {
    // ── Class teacher: complete own-class workflow ───────────────────────────
    console.log('\n— class teacher (assigned) —');
    await check('can enter CA scores for their own class', async () => {
      const out1: any = await ca(actors.teacher!, 0, scopeA, 'ca1');
      const out2: any = await ca(actors.teacher!, 0, scopeA, 'ca2');
      assert.equal(out1.ok, true, out1.error);
      assert.equal(out2.ok, true, out2.error);
    });
    await check('cannot enter CA scores for a class they do not teach', async () => {
      const out: any = await ca(actors.teacher!, 1, scopeB);
      assert.equal(out.ok, false);
    });
    await check('cannot compile — compilation is a results-office action, not a class-teacher one', async () => {
      await assert.rejects(compileClassResults(actors.teacher!, scopeA), /do not have permission to manage results/i);
    });
    await check('can save their own class-teacher remark ranges', () => saveRanges(actors.teacher!, 'class_teacher', [{ min: 90, remark: 'Excellent' }, { min: 0, remark: 'Improve' }]));
    await check('cannot save the principal ranges', async () => {
      await assert.rejects(saveRanges(actors.teacher!, 'principal', [{ min: 90, remark: 'x' }, { min: 0, remark: 'y' }]), /not assigned|signature/i);
    });

    console.log('\n— teacher (unassigned) —');
    await check('cannot enter CA scores anywhere', async () => {
      const out: any = await ca(actors.plain_teacher!, 0, scopeA);
      assert.equal(out.ok, false);
    });
    await check('cannot compile any class', async () => {
      await assert.rejects(compileClassResults(actors.plain_teacher!, scopeA), /do not have permission to manage results/i);
    });

    console.log('\n— exam officer —');
    await check('can enter CA scores school-wide (their office)', async () => {
      const out1: any = await ca(actors.exam_officer!, 1, scopeB, 'ca1');
      const out2: any = await ca(actors.exam_officer!, 1, scopeB, 'ca2');
      assert.equal(out1.ok, true, out1.error);
      assert.equal(out2.ok, true, out2.error);
    });
    await check('can compile any class', () => compileClassResults(actors.exam_officer!, scopeB));
    await check('cannot publish results', async () => {
      await assert.rejects(transitionClassResults(actors.exam_officer!, scopeA, 'reviewed'), /Only the principal/i);
    });

    console.log('\n— vice principal —');
    await check('can compile any class', () => compileClassResults(actors.vice_principal!, scopeA));
    await check('cannot publish results', async () => {
      await assert.rejects(transitionClassResults(actors.vice_principal!, scopeA, 'published'), /Only the principal/i);
    });

    console.log('\n— principal —');
    await check('can review and publish the term', async () => {
      await transitionClassResults(actors.principal!, scopeA, 'reviewed');
      await transitionClassResults(actors.principal!, scopeA, 'published');
      await transitionClassResults(actors.principal!, scopeB, 'reviewed');
      await transitionClassResults(actors.principal!, scopeB, 'published');
    });
    await check('can save principal remark ranges', () => saveRanges(actors.principal!, 'principal', [{ min: 90, remark: 'A brilliant report' }, { min: 0, remark: 'The next term will be better' }]));
    await check('can issue transcripts and families can verify them', async () => {
      assert.equal(canIssueTranscript(actors.principal!), true);
      const issued: any = await issueTranscript(actors.principal!, students[0]!.id, 'transfer');
      assert.ok(issued.serial);
      assert.equal(verifyCode(issued.serial, verificationCode(issued.serial)), true, 'the printed QR code must verify');
      assert.equal(verifyCode(issued.serial, verificationCode(issued.serial) + 'x'), false, 'a tampered code must fail');
    });

    console.log('\n— non-leadership transcript denial —');
    await check('vice principal, exam officer, teacher, student and parent cannot issue transcripts', () => {
      for (const key of ['vice_principal', 'exam_officer', 'teacher', 'plain_teacher', 'student', 'parent']) {
        assert.equal(canIssueTranscript(actors[key]!), false, key + ' must not pass canIssueTranscript');
      }
    });

    console.log('\n— report sheet access matrix —');
    await check('student sees exactly their own report', async () => {
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.student!, students[0]!.id, session!.id)), 'family');
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.student!, students[1]!.id, session!.id)), null);
    });
    await check('parent sees only their own child (canViewResults respected)', async () => {
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.parent!, students[0]!.id, session!.id)), 'family');
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.parent!, students[1]!.id, session!.id)), null);
    });
    await check('class teacher sees only their own class; school-wide staff see everything', async () => {
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.teacher!, students[0]!.id, session!.id)), 'teacher');
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.teacher!, students[1]!.id, session!.id)), null);
      assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors.plain_teacher!, students[0]!.id, session!.id)), null);
      for (const key of ['principal', 'vice_principal', 'exam_officer']) {
        assert.equal(await forSchool(schoolId, async t => reportAudience(t, actors[key]!, students[1]!.id, session!.id)), 'staff');
      }
    });

    console.log('\n— announcements —');
    await check('leadership may address every audience; teachers only their classes', () => {
      assert.deepEqual(allowedAudiences(actors.principal!), [...ANNOUNCEMENT_AUDIENCES]);
      assert.deepEqual(allowedAudiences(actors.vice_principal!), [...ANNOUNCEMENT_AUDIENCES]);
      assert.deepEqual(allowedAudiences(actors.teacher!), ['class', 'guardians']);
      assert.deepEqual(allowedAudiences(actors.plain_teacher!), ['class', 'guardians']);
      assert.deepEqual(allowedAudiences(actors.student!), []);
      assert.deepEqual(allowedAudiences(actors.parent!), []);
    });
    await check('teacher can announce to their own class but not the school', async () => {
      await forSchool(schoolId, async t => assertCanCreate(t, actors.teacher!, { audience: 'class', audienceRef: classes[0]!.id, subject: 'PTA', body: 'Friday 4pm' }));
      await assert.rejects(forSchool(schoolId, async t => assertCanCreate(t, actors.teacher!, { audience: 'class', audienceRef: classes[1]!.id, subject: 'Nope', body: 'x' })), /classes you are assigned/i);
      await assert.rejects(forSchool(schoolId, async t => assertCanCreate(t, actors.teacher!, { audience: 'school', audienceRef: null, subject: 'Nope', body: 'x' })), /cannot address/i);
    });

    console.log('\n— promotion office —');
    await check('vice principal can propose a promotion batch; exam officer, teacher and family cannot', async () => {
      const batch: any = await proposePromotion(actors.vice_principal!, { fromSessionId: session!.id, toSessionId: nextSession!.id, levelId: level!.id, rules: { passMark: 10, promoteAverage: 60, trialAverage: 30, minSubjectsPassed: 1, mustPassCodes: [], requireCore: false } });
      assert.ok(batch.batchId);
      for (const key of ['exam_officer', 'teacher', 'plain_teacher', 'student', 'parent']) {
        await assert.rejects(proposePromotion(actors[key]!, { fromSessionId: session!.id, toSessionId: nextSession!.id, levelId: level!.id, rules: { passMark: 10, promoteAverage: 60, trialAverage: 30, minSubjectsPassed: 1, mustPassCodes: [], requireCore: false } }), /Only the principal or vice principal/i, key + ' must not propose promotion');
      }
    });

    console.log('\n— portal notifications —');
    await check('published results reached the student and parent inboxes', async () => {
      const studentInbox: any = await forSchool(schoolId, async t => inbox(t, { schoolId, userId: byRole.student!.id }));
      const parentInbox: any = await forSchool(schoolId, async t => inbox(t, { schoolId, userId: byRole.parent!.id }));
      assert.ok(studentInbox.length >= 1, 'student must be notified');
      assert.ok(parentInbox.length >= 1, 'parent must be notified');
    });

    console.log('\n— family denial on live services —');
    await check('student and parent cannot compile, publish, or enter scores', async () => {
      for (const key of ['student', 'student2', 'parent']) {
        const out: any = await ca(actors[key]!, 0, scopeA);
        assert.equal(out.ok, false, key + ' must not enter scores');
        await assert.rejects(compileClassResults(actors[key]!, scopeA));
        await assert.rejects(transitionClassResults(actors[key]!, scopeA, 'reviewed'));
      }
    });
    await check('a parent cannot push a manual remark onto a report', async () => {
      await assert.rejects(saveManualRemark(actors.parent!, { studentId: students[0]!.id, sessionId: session!.id, termId: term!.id, role: 'principal', remark: 'Fraud' }), /Principal|not assigned|configuration/i);
    });

    console.log('\nROLE COMPLETENESS OK: ' + count + ' checks passed. Every role can reach its whole office, and nothing beyond it.');
  } finally {
    await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    // The '@/db' module singleton stays connected after forSchool calls; close
    // it so a passing run actually exits (same CI-hang fix as promotion).
    await appSingleton.end().catch(() => {});
    await owner.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
