/**
 * One-off QA fixture for the Test/Exam Sessions (live board) and Marking
 * Status visual QA pass. NOT a test — leaves data in the local *_ca_test
 * database and prints ready-to-use session cookies for curl/Playwright.
 *
 *   set -a && . .env.local && set +a && npx tsx scripts/qa-seed-sessions-marking.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
    throw new Error('QA seed requires a disposable local *_ca_test database.');
  }
  const { schema } = await import('../src/db');
  const { createSession } = await import('../src/lib/auth/session-store');
  const engine = await import('../src/lib/exam/engine');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });

  const code = 'QA' + randomUUID().slice(0, 6).toUpperCase();
  const [school] = await db.insert(schema.schools).values({ name: 'QA Sessions School', code, settings: { assessmentComponents: [] } }).returning();
  const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
  const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
  const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS3' }).returning();
  const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS3 A', arm: 'A' }).returning();
  const [subject] = await db.insert(schema.subjects).values({ schoolId, name: 'Biology', code: 'BIO', isCompulsory: false }).returning();

  const user = async (role: 'exam_officer' | 'teacher' | 'student', tag: string) => {
    const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: role + tag + '-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    return u!;
  };

  const officerUser = await user('exam_officer', '');
  const [officerStaff] = await db.insert(schema.staff).values({ schoolId, userId: officerUser.id, role: 'exam_officer', staffNumber: 'X0', firstName: 'Kemi', lastName: 'Adebayo', status: 'active' }).returning();

  const teacherUser = await user('teacher', '');
  const [teacherStaff] = await db.insert(schema.staff).values({ schoolId, userId: teacherUser.id, role: 'teacher', staffNumber: 'T0', firstName: 'Grace', lastName: 'Nwosu', status: 'active' }).returning();
  await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacherStaff!.id, classId: klass!.id, subjectId: subject!.id, assignmentType: 'subject_teacher', status: 'active' });

  const students: number[] = [];
  const names = [['Ada', 'Bello'], ['Chidi', 'Okoro'], ['Fatima', 'Yusuf']];
  for (let i = 0; i < 3; i++) {
    const su = await user('student', 's' + i);
    const [st] = await db.insert(schema.students).values({ schoolId, userId: su.id, admissionNumber: 'QS-S' + i, firstName: names[i]![0]!, lastName: names[i]![1]!, status: 'active' }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId: klass!.id, sessionId: session!.id, status: 'active' });
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: st!.id, subjectId: subject!.id, sessionId: session!.id });
    students.push(st!.id);
  }

  const [series] = await db.insert(schema.examSeries).values({
    schoolId, sessionId: session!.id, termId: term!.id,
    title: 'QA Terminal', seriesType: 'examination',
    sittingOpensAt: new Date(Date.now() - 24 * 3600 * 1000),
    sittingClosesAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    status: 'published',
  }).returning();

  // A paper that started 10 minutes ago and closes in 50 — live right now.
  const start = new Date(Date.now() - 10 * 60 * 1000);
  const [paper] = await db.insert(schema.examPapers).values({
    schoolId, seriesId: series!.id, subjectId: subject!.id, classId: klass!.id, levelId: level!.id,
    scheduledAt: start, closesAt: new Date(start.getTime() + 3600_000),
    durationSeconds: 3600, status: 'published', questionCount: 2,
    requiresAccessCode: true, invigilatorStaffId: teacherStaff!.id,
  }).returning();

  const { eq } = await import('drizzle-orm');
  await db.update(schema.examPapers).set({ accessCode: 'BIO123' }).where(eq(schema.examPapers.id, paper!.id));

  const [setRow] = await db.insert(schema.questionSets).values({
    schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id,
    levelId: level!.id, examType: 'objective', status: 'approved',
  }).returning();
  const [objQ] = await db.insert(schema.questions).values({ schoolId, questionSetId: setRow!.id, questionText: 'The powerhouse of the cell is the ___.', questionType: 'single_choice', marks: '1.00' }).returning();
  await db.insert(schema.questionOptions).values([
    { schoolId, questionId: objQ!.id, optionText: 'Mitochondrion', isCorrect: true },
    { schoolId, questionId: objQ!.id, optionText: 'Nucleus', isCorrect: false },
  ]);
  await db.insert(schema.paperQuestions).values({ schoolId, paperId: paper!.id, questionId: objQ!.id, sortOrder: 0 });

  const [theoryQ] = await db.insert(schema.questions).values({
    schoolId, questionSetId: setRow!.id,
    questionText: 'Explain, in two sentences, why the mitochondrion is called the powerhouse of the cell.',
    questionType: 'theory', marks: '10.00', markingGuide: 'Award marks for ATP/respiration and energy release.',
  }).returning();
  await db.insert(schema.paperQuestions).values({ schoolId, paperId: paper!.id, questionId: theoryQ!.id, sortOrder: 1 });

  // Student 0: never starts (not_started).
  // Student 1: starts and is still writing (in_progress).
  const s1 = await engine.startAttempt(schoolId, paper!.id, students[1]!, 'BIO123');
  if (!s1.ok) throw new Error('student 1 could not start: ' + JSON.stringify(s1));
  await engine.saveAnswer(schoolId, s1.attemptId, students[1]!, { questionId: objQ!.id, optionId: undefined });

  // Student 2: starts, answers both, submits — theory answer lands in marking queue.
  const s2 = await engine.startAttempt(schoolId, paper!.id, students[2]!, 'BIO123');
  if (!s2.ok) throw new Error('student 2 could not start: ' + JSON.stringify(s2));
  await engine.saveAnswer(schoolId, s2.attemptId, students[2]!, { questionId: theoryQ!.id, text: 'Mitochondria break down glucose to release ATP through respiration, giving the cell usable energy.' });
  await engine.submitAttempt(schoolId, s2.attemptId, students[2]!);

  const officerSession = await createSession(officerUser.id, null, null);
  const teacherSession = await createSession(teacherUser.id, null, null);

  console.log(JSON.stringify({
    schoolId, paperId: paper!.id,
    officerCookie: `educbt.session=${officerSession.token}`,
    teacherCookie: `educbt.session=${teacherSession.token}`,
    code,
  }, null, 2));
  await owner.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
