/**
 * Like make-saas-backup-fixture.ts, plus REAL results: scores entered and compiled through the platform's own services,
 * a term summary with remarks and attendance, so the plugin's SaaS-to-plugin results tests run on genuine platform output.
 *   OUT=/tmp/saas-fixture-results npx tsx src/db/make-saas-results-fixture.ts
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

const SETTINGS = {
  assessmentComponents: [
    { key: 'ca1', label: 'CA One', maxScore: 20, isExam: false },
    { key: 'ca2', label: 'CA Two', maxScore: 10, isExam: false },
    { key: 'exam', label: 'Exam', maxScore: 70, isExam: true },
  ],
  gradingScale: { id: 'school-default', name: 'School scale', version: 1, bands: [
    { min: 70, grade: 'A', remark: 'Excellent', pass: true }, { min: 60, grade: 'B', remark: 'Very good', pass: true },
    { min: 50, grade: 'C', remark: 'Good', pass: true }, { min: 40, grade: 'D', remark: 'Fair', pass: true },
    { min: 0, grade: 'F', remark: 'Fail', pass: false } ] },
  rankingPolicy: { tiePolicy: 'competition', tiebreakers: ['exam'], rankIncomplete: false },
};

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Needs a disposable local *_ca_test database.');
  const { schema } = await import('@/db');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const { enterScore } = await import('@/lib/exam/results');
  const { compileClassResults } = await import('@/lib/results/workflow');
  const out = process.env.OUT ?? '/tmp/saas-fixture-results'; mkdirSync(out, { recursive: true });
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const code = 'RX' + randomUUID().slice(0, 5).toUpperCase();
  const { hashPassword: hash } = await import('@/lib/auth/password');

  const [school] = await db.insert(schema.schools).values({ name: 'Results College', code, subdomain: code.toLowerCase(), address: '2 Palm Road', settings: SETTINGS }).returning();
  const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/2026', isCurrent: true }).returning();
  const [t1] = await db.insert(schema.terms).values([{ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }]).returning();
  const [lvl] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS 1', stage: 'junior', levelOrder: 1 }).returning();
  const [cls] = await db.insert(schema.classes).values({ schoolId, levelId: lvl!.id, displayName: 'JSS 1 A', arm: 'A', capacity: 40 }).returning();
  const [math, eng] = await db.insert(schema.subjects).values([{ schoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true, category: 'core' }, { schoolId, name: 'English', code: 'ENG', isCompulsory: true, category: 'core' }]).returning();
  const mk = async (role: string, loginId: string, pw: string) => (await db.insert(schema.users).values({ schoolId, role: role as never, loginId, passwordHash: await hash(pw), status: 'active' } as never).returning())[0]!;
  const uT = await mk('teacher', 'rx/stf/001', 'Teacher#1');
  const [teacher] = await db.insert(schema.staff).values({ schoolId, userId: uT.id, role: 'teacher', staffNumber: 'RX/STF/001', firstName: 'Tunde', lastName: 'Bello' } as never).returning();
  await db.insert(schema.staffAssignments).values([{ schoolId, staffId: teacher!.id, classId: cls!.id, assignmentType: 'class_teacher' }, { schoolId, staffId: teacher!.id, classId: cls!.id, subjectId: math!.id, assignmentType: 'subject_teacher' }, { schoolId, staffId: teacher!.id, classId: cls!.id, subjectId: eng!.id, assignmentType: 'subject_teacher' }] as never);
  const uP = await mk('principal', 'rx/stf/002', 'Principal#2');
  const [principalStaff] = await db.insert(schema.staff).values({ schoolId, userId: uP.id, role: 'principal', staffNumber: 'RX/STF/002', firstName: 'Ngozi', lastName: 'Eze' } as never).returning();
  // One published examination with a WRITTEN paper per subject: the platform lets the subject teacher type the exam mark for those.
  const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: t1!.id, title: 'First Term Examination', seriesType: 'examination', status: 'published' } as never).returning();
  for (const sub of [math!, eng!]) await db.insert(schema.examPapers).values({ schoolId, seriesId: series!.id, subjectId: sub.id, classId: cls!.id, status: 'published', deliveryMode: 'written' } as never);
  const people: Array<{ id: number; adm: string }> = [];
  for (const [i, [f, l]] of ([['Ada', 'Obi'], ['Musa', 'Ibrahim'], ['Zainab', 'Lawal']] as const).entries()) {
    const adm = `RX/26/00${i + 1}`; const u = await mk('student', `rx/stu/00${i + 1}`, `Student#${i + 1}`);
    const [s] = await db.insert(schema.students).values({ schoolId, userId: u.id, admissionNumber: adm, firstName: f, lastName: l, parentName: 'Parent', parentPhone: '08030000000' } as never).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId: cls!.id, sessionId: session!.id });
    for (const sub of [math!, eng!]) await db.insert(schema.studentSubjects).values({ schoolId, studentId: s!.id, subjectId: sub.id, sessionId: session!.id });
    people.push({ id: s!.id, adm });
  }
  const actor = { userId: uT.id, schoolId, role: 'teacher', loginId: 'rx/stf/001', staffId: teacher!.id, studentId: null };
  const principalActor = { userId: uP.id, schoolId, role: 'principal', loginId: 'rx/stf/002', staffId: principalStaff!.id, studentId: null };
  const report: Record<string, unknown> = { schoolId, code, students: people };
  // Scores: 3 students x 2 subjects x 3 components. Student 3 is missing Maths ca2 on purpose (an incomplete result).
  const marks: Record<string, [number, number, number]> = { '0:0': [18, 9, 60], '0:1': [15, 7, 52], '1:0': [12, 6, 45], '1:1': [10, 5, 38], '2:0': [20, 0, 70], '2:1': [8, 4, 30] };
  const rejected: string[] = [];
  for (const [si, st] of people.entries()) for (const [bi, sub] of [math!, eng!].entries()) {
    const m = marks[`${si}:${bi}`]!;
    for (const [ci, comp] of (SETTINGS.assessmentComponents).entries()) {
      if (si === 2 && bi === 0 && comp.key === 'ca2') continue;
      const r = await enterScore(actor, { studentId: st.id, subjectId: sub.id, classId: cls!.id, sessionId: session!.id, termId: t1!.id, componentKey: comp.key, score: m[ci]!, maxScore: comp.maxScore });
      if (!r.ok) rejected.push(`${st.adm}/${sub.code}/${comp.key}: ${r.error}`);
    }
  }
  report.rejected = rejected;
  let compiled: unknown = null; let compileError: string | null = null;
  try { compiled = await compileClassResults(principalActor, { classId: cls!.id, sessionId: session!.id, termId: t1!.id }); } catch (e) { compileError = (e as Error).message; }
  report.compiled = compiled; report.compileError = compileError;
  // A term summary the way the platform stores it: remarks, attendance, and an approval trail.
  for (const [i, st] of people.entries()) {
    await db.insert(schema.termSummaries).values({ schoolId, studentId: st.id, sessionId: session!.id, termId: t1!.id, classId: cls!.id,
      classTeacherRemark: i === 0 ? 'A diligent and polite student.' : '', principalRemark: i === 0 ? 'Keep it up.' : '', daysPresent: 50 - i * 6, daysTotal: 60,
      status: i === 0 ? 'published' : 'draft', publishedAt: i === 0 ? new Date() : null } as never);
  }
  const counts = {
    scores: (await db.select().from(schema.assessmentScores).where(eq(schema.assessmentScores.schoolId, schoolId))).length,
    results: (await db.select().from(schema.subjectResults).where(eq(schema.subjectResults.schoolId, schoolId))).length,
  };
  report.counts = counts;
  console.log('rejected:', rejected.length, rejected.slice(0, 3).join(' | '), '| compile:', compileError ?? JSON.stringify(compiled), '| counts', JSON.stringify(counts));
  const hashed = await exportSchool(schoolId, { includePasswords: true });
  writeFileSync(`${out}/saas-results.gz`, hashed.file);
  writeFileSync(`${out}/saas-results.json`, JSON.stringify({ ...report, classId: cls!.id, termId: t1!.id, sessionId: session!.id, subjects: [math!.id, eng!.id], exportCounts: hashed.counts }));
  await owner.end(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
