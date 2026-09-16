/**
 * One-off QA fixture for the Timetable / Invigilation Schedule visual QA pass.
 * NOT a test — leaves data in the local *_ca_test database and prints a
 * ready-to-use session cookie for curl/Playwright.
 *
 *   set -a && . .env.local && set +a && npx tsx scripts/qa-seed-timetable.ts
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
    throw new Error('QA seed requires a disposable local *_ca_test database.');
  }
  const { schema } = await import('../src/db');
  const { createSession } = await import('../src/lib/auth/session-store');
  const { setPaperInvigilator, regenerateAccessCode } = await import('../src/lib/exam/timetable');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });

  const code = 'QA' + randomUUID().slice(0, 6).toUpperCase();
  const [school] = await db.insert(schema.schools).values({ name: 'QA Parity School', code, settings: { assessmentComponents: [] } }).returning();
  const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
  const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true }).returning();
  const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS3' }).returning();
  const [klass] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS3 A', arm: 'A' }).returning();
  const subjects = await db.insert(schema.subjects).values([
    { schoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true },
    { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false },
    { schoolId, name: 'English Language', code: 'ENG', isCompulsory: true },
  ]).returning();

  const user = async (role: 'exam_officer' | 'teacher', tag: string) => {
    const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: role + tag + '-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    return u!;
  };
  const officerUser = await user('exam_officer', '');
  const [officerStaff] = await db.insert(schema.staff).values({ schoolId, userId: officerUser.id, role: 'exam_officer', staffNumber: 'X0', firstName: 'Kemi', lastName: 'Adebayo', status: 'active' }).returning();
  const tA = await user('teacher', 'a');
  const [staffA] = await db.insert(schema.staff).values({ schoolId, userId: tA.id, role: 'teacher', staffNumber: 'T0', firstName: 'Grace', lastName: 'Nwosu', status: 'active' }).returning();
  const tB = await user('teacher', 'b');
  const [staffB] = await db.insert(schema.staff).values({ schoolId, userId: tB.id, role: 'teacher', staffNumber: 'T1', firstName: 'Femi', lastName: 'Okafor', status: 'active' }).returning();

  const [series] = await db.insert(schema.examSeries).values({
    schoolId, sessionId: session!.id, termId: term!.id,
    title: 'First Term Examination', seriesType: 'examination',
    sittingOpensAt: new Date(Date.now() - 24 * 3600 * 1000),
    sittingClosesAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    status: 'published',
  }).returning();

  const at = (hourFromNow: number) => new Date(Date.now() + hourFromNow * 3600 * 1000);
  const paper = async (subjectId: number, startsIn: number, needsCode: boolean) => {
    const start = at(startsIn);
    const [p] = await db.insert(schema.examPapers).values({
      schoolId, seriesId: series!.id, subjectId, classId: klass!.id, levelId: level!.id,
      scheduledAt: start, closesAt: new Date(start.getTime() + 3600_000),
      durationSeconds: 3600, status: 'published', questionCount: 2,
      requiresAccessCode: needsCode,
    }).returning();
    return p!;
  };
  const maths = await paper(subjects[0]!.id, 3, true);
  const bio = await paper(subjects[1]!.id, 6, true);
  const eng = await paper(subjects[2]!.id, 9, false);

  const office = { userId: officerUser.id, schoolId, role: 'exam_officer', loginId: 'qa', staffId: officerStaff!.id, studentId: null } as const;
  await setPaperInvigilator(office, maths.id, staffB!.id, false); // teaches Biology, not Maths — clean assignment
  await regenerateAccessCode(office, maths.id);
  // Biology and English are left unscheduled-invigilator / uncoded on purpose,
  // so the QA pass sees both the filled and the empty states in one screen.

  const { token } = await createSession(officerUser.id, null, null);

  console.log(JSON.stringify({ schoolId, seriesId: series!.id, cookie: `educbt.session=${token}`, code }, null, 2));
  await owner.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
