/**
 * Shared fixture for the report-card suites (single sheet baseline and bulk class print). Disposable LOCAL database
 * only. Builds a school with a principal, a class teacher and two classes:
 *
 *   JSS1 A  five students, three subjects, results PUBLISHED (one student is missing one score, so that subject is
 *           "not ranked" on their sheet; one has a longer name so ordering by LAST name is observable)
 *   JSS1 B  two students, results compiled but NOT published
 *
 * Returns session tokens for each role so a suite can fetch pages over HTTP exactly as a browser would.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { WAEC_NINE_POINT, DEFAULT_RANKING } from '@/domain/academic';
import type { Actor } from '@/lib/session';

export async function reportFixtureEnv() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local *_ca_test database required');
  }
  const { schema, client } = await import('@/db');
  const { enterScore, compileSubject } = await import('@/lib/exam/results');
  const { compileClassResults, transitionClassResults } = await import('@/lib/results/workflow');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  void compileSubject;
  const settings = { assessmentComponents: [
    { key: 'ca1', label: 'First CA', maxScore: 20, isExam: false },
    { key: 'ca2', label: 'Second CA', maxScore: 10, isExam: false },
    { key: 'exam', label: 'Examination', maxScore: 70, isExam: true },
  ], gradingScale: WAEC_NINE_POINT, rankingPolicy: DEFAULT_RANKING };

  const schools: number[] = [];
  const sessionToken = async (userId: number) => {
    const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId, expiresAt: new Date(Date.now() + 3600000) });
    return token;
  };

  /** `crest`: give the school a logo so the watermark path is exercised. */
  async function build(opts: { crest?: boolean } = {}) {
    const [school] = await db.insert(schema.schools).values({
      name: 'Bulk report school', code: 'BR-' + randomUUID(), settings,
      address: '1 School Road', phone: '0800000000', email: 'school@example.test', principalName: 'Mrs Principal',
      ...(opts.crest ? { logoUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMjgiIGZpbGw9IiMxNDUzMmQiLz48L3N2Zz4=' } : {}),
    } as never).returning();
    const schoolId = school!.id; schools.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First term', isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [classA, classB] = await db.insert(schema.classes).values(['A', 'B'].map((arm) => ({ schoolId, levelId: level!.id, arm, displayName: 'JSS1 ' + arm }))).returning();
    const subjects = await db.insert(schema.subjects).values([
      { schoolId, name: 'Mathematics', code: 'MTH' }, { schoolId, name: 'English', code: 'ENG' }, { schoolId, name: 'Biology', code: 'BIO' },
    ]).returning();
    const users = await db.insert(schema.users).values((['principal', 'teacher', 'teacher', 'student', 'parent'] as const)
      .map((role, i) => ({ schoolId, role, loginId: role + i, passwordHash: 'unused', mustChangePassword: false }))).returning();
    const [principalU, teacherU, otherTeacherU, studentU] = users;
    const staffRows = await db.insert(schema.staff).values([
      { schoolId, userId: teacherU!.id, firstName: 'Tina', lastName: 'Teacher', staffNumber: 'T1', role: 'teacher' },
      { schoolId, userId: otherTeacherU!.id, firstName: 'Omar', lastName: 'Other', staffNumber: 'T2', role: 'teacher' },
    ] as never).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: staffRows[0]!.id, classId: classA!.id, assignmentType: 'class_teacher', status: 'active' } as never);
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: staffRows[1]!.id, classId: classB!.id, assignmentType: 'class_teacher', status: 'active' } as never);

    // Deliberately NOT in alphabetical insert order: ordering by last name then first name must be visible.
    const namesA = [['Zara', 'Okoro'], ['Adam', 'Bello'], ['Chi', 'Bello'], ['Ife', 'Adeyemi'], ['Musa', 'Yusuf']];
    const namesB = [['Bola', 'Cole'], ['Dayo', 'Ajayi']];
    const mk = async (names: string[][], classId: number, prefix: string) => {
      const rows = await db.insert(schema.students).values(names.map(([f, l], n) => ({ schoolId, admissionNumber: prefix + (n + 1), firstName: f!, lastName: l! }))).returning();
      for (const s of rows) {
        await db.insert(schema.enrollments).values({ schoolId, studentId: s.id, sessionId: session!.id, classId });
        for (const sub of subjects) await db.insert(schema.studentSubjects).values({ schoolId, studentId: s.id, sessionId: session!.id, subjectId: sub.id });
      }
      return rows;
    };
    const studentsA = await mk(namesA, classA!.id, 'A');
    const studentsB = await mk(namesB, classB!.id, 'B');
    await db.update(schema.students).set({ userId: studentU!.id }).where(eq(schema.students.id, studentsA[0]!.id));

    const principal = { schoolId, userId: principalU!.id, role: 'principal', loginId: principalU!.loginId, staffId: null, studentId: null } as Actor;
    const scopeFor = (classId: number) => ({ classId, sessionId: session!.id, termId: term!.id });
    const score = async (classId: number, studentId: number, subjectId: number, key: string, value: number, max: number) =>
    { const r = await enterScore(principal, { ...scopeFor(classId), subjectId, studentId, componentKey: key, score: value, maxScore: max }); assert(r.ok, `score entry refused: ${r.error}`); }
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'Terminal', status: 'published' }).returning();
    // One 70-mark question per subject: a student's exam score is the marks awarded on their attempt (a CBT mark is
    // never typed in, it comes from the marked attempt).
    const examFor = new Map<number, { paperId: number; questionId: number }>();
    const questionFor = new Map<number, number>();
    for (const sub of subjects) {
      const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: sub.id, levelId: level!.id, seriesId: series!.id, examType: 'objective' }).returning();
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: 'Fixture', marks: '70' }).returning();
      questionFor.set(sub.id, q!.id);
    }
    for (const classId of [classA!.id, classB!.id]) for (const sub of subjects) {
      const [paper] = await db.insert(schema.examPapers).values({ schoolId, seriesId: series!.id, subjectId: sub.id, classId, status: 'published' as const }).returning();
      examFor.set(classId * 1000 + sub.id, { paperId: paper!.id, questionId: questionFor.get(sub.id)! });
    }
    const fill = async (classId: number, students: Array<{ id: number }>, skip: { studentId: number; subjectId: number } | null) => {
      // Scores depend only on a student's and subject's POSITION, never on database ids, so two builds give identical sheets.
      for (const [i, s] of students.entries()) for (const [j, sub] of subjects.entries()) {
        if (skip && skip.studentId === s.id && skip.subjectId === sub.id) continue;
        await score(classId, s.id, sub.id, 'ca1', 10 + ((i * 3 + j) % 10), 20);
        await score(classId, s.id, sub.id, 'ca2', 5 + ((i + j) % 5), 10);
        const e = examFor.get(classId * 1000 + sub.id)!;
        const [attempt] = await db.insert(schema.attempts).values({ schoolId, paperId: e.paperId, studentId: s.id, status: 'submitted', questionOrder: [e.questionId], expiresAt: new Date() }).returning();
        await db.insert(schema.attemptAnswers).values({ schoolId, attemptId: attempt!.id, questionId: e.questionId, awardedMarks: String(30 + ((i * 7 + j * 3) % 40)) });
      }
    };
        // Publishing demands every registered subject be complete, so a published class has no gaps.
    await fill(classA!.id, studentsA, null);
    await fill(classB!.id, studentsB, null);
    return { db, schoolId, schoolRow: school!, session: session!, term: term!, classA: classA!, classB: classB!, studentsA, studentsB, subjects,
      principal, users, staff: staffRows, scopeFor, studentUser: studentU!, teacherUser: teacherU!, otherTeacherUser: otherTeacherU!,
      principalUser: principalU!,
      compile: (classId: number) => compileClassResults(principal, scopeFor(classId)),
      move: (classId: number, to: Parameters<typeof transitionClassResults>[2]) => transitionClassResults(principal, scopeFor(classId), to) };
  }

  async function cleanup() {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
  return { schema, db, build, sessionToken, cleanup };
}
