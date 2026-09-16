/**
 * Exam Office dashboard checks (examOfficeDashboard).
 * Run with a disposable LOCAL database; never at production.
 *   npx tsx src/db/test-exam-dashboard.ts
 *
 * Legacy reference: templates/portal/exams/index.php (Examinations overview —
 * the "wide" / examination-officer branch; this route is unreachable by
 * narrower roles in the Next.js app).
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
  const { schema } = await import('@/db');
  const { examOfficeDashboard } = await import('@/lib/exam/dashboard');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const ids: number[] = [];
  let checks = 0;
  async function check(name: string, test: () => Promise<unknown> | unknown) { await test(); checks++; console.log('PASS  ' + name); }

  async function fixture() {
    const code = 'EO-' + randomUUID().slice(0, 8);
    const [school] = await db.insert(schema.schools).values({ name: 'Exam office test', code }).returning();
    const schoolId = school!.id; ids.push(schoolId);

    const [officerUser] = await db.insert(schema.users).values({
      schoolId, role: 'exam_officer', loginId: 'officer-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const [officerStaff] = await db.insert(schema.staff).values({
      schoolId, userId: officerUser!.id, role: 'exam_officer', staffNumber: 'EO1', firstName: 'Ola', lastName: 'Officer', status: 'active',
    }).returning();
    const officer: Actor = { schoolId, userId: officerUser!.id, role: 'exam_officer', staffId: officerStaff!.id, studentId: null, loginId: officerUser!.loginId };

    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Maths' }).returning();

    return { schoolId, officer, session: session!, term: term!, level: level!, klass: klass!, subject: subject! };
  }

  // ── Empty state: nothing created yet ──────────────────────────────────────
  await check('empty school: all stats are zero and pipeline stages are idle/act', async () => {
    const { officer } = await fixture();
    const dash = await examOfficeDashboard(officer);
    assert.equal(dash.stats.questions, 0);
    assert.equal(dash.stats.papers, 0);
    assert.equal(dash.stats.published, 0);
    assert.equal(dash.stats.sat, 0);
    assert.equal(dash.stats.theoryPending, 0);
    assert.equal(dash.pipeline.length, 7);
    assert.equal(dash.pipeline[0]!.state, 'idle');
    assert.equal(dash.pipeline[2]!.state, 'act'); // "Examination created" — none yet
    assert.equal(dash.pipeline[2]!.action, 'Create examination');
    assert.equal(dash.heading, 'Examination Officer Dashboard');
    assert.deepEqual(dash.upcoming, []);
    assert.deepEqual(dash.recentSittings, []);
  });

  // ── Question sets drive the first two pipeline stages ─────────────────────
  await check('a draft set puts "Questions submitted" in the wait state', async () => {
    const { officer, schoolId, session, term, subject, level } = await fixture();
    await db.insert(schema.questionSets).values({
      schoolId, sessionId: session.id, termId: term.id, subjectId: subject.id, levelId: level.id,
      examType: 'objective', status: 'draft',
    });
    const dash = await examOfficeDashboard(officer);
    assert.equal(dash.pipeline[0]!.state, 'wait');
    assert.match(dash.pipeline[0]!.note, /still being written/);
  });

  await check('a submitted set awaits review, and moves the pipeline to "act"', async () => {
    const { officer, schoolId, session, term, subject, level } = await fixture();
    await db.insert(schema.questionSets).values({
      schoolId, sessionId: session.id, termId: term.id, subjectId: subject.id, levelId: level.id,
      examType: 'objective', status: 'submitted',
    });
    const dash = await examOfficeDashboard(officer);
    assert.equal(dash.pipeline[0]!.state, 'done'); // nothing left drafting
    assert.equal(dash.pipeline[1]!.state, 'act');
    assert.match(dash.pipeline[1]!.note, /waiting on your decision/);
  });

  // ── Papers, published stat and "Examination created" stage ───────────────
  await check('papers/published stats and the series pipeline stage reflect real rows', async () => {
    const { officer, schoolId, session, term, subject, klass, level } = await fixture();
    const [series] = await db.insert(schema.examSeries).values({
      schoolId, sessionId: session.id, termId: term.id, title: 'First Term Examination', seriesType: 'examination', status: 'open',
    }).returning();
    await db.insert(schema.examPapers).values([
      { schoolId, seriesId: series!.id, subjectId: subject.id, classId: klass.id, levelId: level.id, status: 'published', scheduledAt: new Date(Date.now() + 86400000) },
      { schoolId, seriesId: series!.id, subjectId: subject.id, classId: klass.id, levelId: level.id, status: 'draft' },
    ]);

    const dash = await examOfficeDashboard(officer);
    assert.equal(dash.stats.papers, 2);
    assert.equal(dash.stats.published, 1);
    assert.equal(dash.pipeline[2]!.state, 'done');
    assert.equal(dash.pipeline[2]!.note, 'First Term Examination');
    assert.equal(dash.pipeline[2]!.href, `/portal/exams/${series!.id}`);
    // scheduled=2, unpublished(draft)=1 -> "Papers published" stage is "act"
    assert.equal(dash.pipeline[5]!.state, 'act');
    assert.match(dash.pipeline[5]!.note, /1 paper\(s\) still in draft/);
    // one paper is scheduled for tomorrow -> shows in "Next papers"
    assert.equal(dash.upcoming.length, 1);
    assert.equal(dash.upcoming[0]!.subjectName, 'Maths');
  });

  // ── Attempts drive "sat", "theoryPending" and Recent sittings ─────────────
  await check('sat/theoryPending stats and recent sittings reflect real attempts', async () => {
    const { officer, schoolId, session, term, subject, klass, level } = await fixture();
    const [series] = await db.insert(schema.examSeries).values({
      schoolId, sessionId: session.id, termId: term.id, title: 'CA', seriesType: 'ca_test', status: 'open',
    }).returning();
    const [paper] = await db.insert(schema.examPapers).values({
      schoolId, seriesId: series!.id, subjectId: subject.id, classId: klass.id, levelId: level.id, status: 'published',
    }).returning();
    const [set] = await db.insert(schema.questionSets).values({
      schoolId, sessionId: session.id, termId: term.id, subjectId: subject.id, levelId: level.id, examType: 'theory', status: 'approved',
    }).returning();
    const [question] = await db.insert(schema.questions).values({
      schoolId, questionSetId: set!.id, questionText: 'Explain X.', questionType: 'theory',
    }).returning();

    const [studentUser] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: 'stu-' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning();
    const [student] = await db.insert(schema.students).values({
      schoolId, userId: studentUser!.id, admissionNumber: 'A1', firstName: 'Sam', lastName: 'Student', status: 'active',
    }).returning();
    const [attemptDone] = await db.insert(schema.attempts).values({
      schoolId, paperId: paper!.id, studentId: student!.id, status: 'submitted', expiresAt: new Date(),
    }).returning();
    await db.insert(schema.attemptAnswers).values({
      schoolId, attemptId: attemptDone!.id, questionId: question!.id, textAnswer: 'X is...', awardedMarks: '5.00',
    });

    let dash = await examOfficeDashboard(officer);
    assert.equal(dash.stats.sat, 1);
    assert.equal(dash.stats.theoryPending, 0);
    assert.equal(dash.pipeline[6]!.state, 'done');
    assert.equal(dash.recentSittings.length, 1);
    assert.equal(dash.recentSittings[0]!.sat, 1);
    assert.equal(dash.recentSittings[0]!.pct, 100);

    // A second student sits and is NOT yet marked -> theoryPending rises, "sat"
    // (fully graded) does not count this attempt, and marking is not "done".
    const [studentUser2] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: 'stu2-' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning();
    const [student2] = await db.insert(schema.students).values({
      schoolId, userId: studentUser2!.id, admissionNumber: 'A2', firstName: 'Ada', lastName: 'Student', status: 'active',
    }).returning();
    const [attemptPending] = await db.insert(schema.attempts).values({
      schoolId, paperId: paper!.id, studentId: student2!.id, status: 'submitted', expiresAt: new Date(),
    }).returning();
    await db.insert(schema.attemptAnswers).values({
      schoolId, attemptId: attemptPending!.id, questionId: question!.id, textAnswer: 'Not marked yet',
    });

    dash = await examOfficeDashboard(officer);
    assert.equal(dash.stats.sat, 1); // still just the marked one
    assert.equal(dash.stats.theoryPending, 1);
    assert.equal(dash.pipeline[6]!.state, 'act');
    assert.equal(dash.recentSittings[0]!.sat, 2);
    assert.equal(dash.recentSittings[0]!.pct, 100); // "graded" here means finished sitting, both submitted
  });

  console.log(`\n${checks} exam dashboard checks passed.`);
  for (const id of ids) await db.delete(schema.schools).where(eq(schema.schools.id, id));
  await owner.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
