/**
 * One-off QA fixture for the assign-duties builder and teacher roster exports.
 * NOT a test: leaves data in the local *_ca_test database and prints cookies.
 *   npx tsx scripts/qa-seed-assignments.ts
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
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });

  const code = 'QA' + randomUUID().slice(0, 6).toUpperCase();
  const [school] = await db.insert(schema.schools).values({ name: 'QA Assign School', code, subdomain: 'qa' + code.slice(2).toLowerCase(), settings: { assessmentComponents: [] } }).returning();
  const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
  await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1, isCurrent: true });
  const [jss1] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS 1', stage: 'junior', levelOrder: 1 }).returning();
  const [jss2] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS 2', stage: 'junior', levelOrder: 2 }).returning();
  const classes = await db.insert(schema.classes).values([
    { schoolId, levelId: jss1!.id, displayName: 'JSS 1A', arm: 'A' },
    { schoolId, levelId: jss1!.id, displayName: 'JSS 1B', arm: 'B' },
    { schoolId, levelId: jss1!.id, displayName: 'JSS 1C', arm: 'C' },
    { schoolId, levelId: jss2!.id, displayName: 'JSS 2A', arm: 'A' },
  ]).returning();
  const subjects = await db.insert(schema.subjects).values([
    { schoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true },
    { schoolId, name: 'Basic Science', code: 'BSC', isCompulsory: false },
  ]).returning();

  const mkUser = async (role: 'principal' | 'teacher' | 'student', tag: string) =>
    (await db.insert(schema.users).values({ schoolId, role, loginId: role + tag + '-' + code, passwordHash: 'unused', mustChangePassword: false }).returning())[0]!;
  const pu = await mkUser('principal', '');
  await db.insert(schema.staff).values({ schoolId, userId: pu.id, role: 'principal', staffNumber: 'P0', firstName: 'Ada', lastName: 'Principal' });

  const teachers: Record<string, { staffId: number; cookie: string }> = {};
  for (const [tag, first, last] of [['1', 'Tunde', 'Bello'], ['2', 'Grace', 'Nwosu'], ['3', 'Kemi', 'Adeyemi']] as const) {
    const u = await mkUser('teacher', tag);
    const [st] = await db.insert(schema.staff).values({ schoolId, userId: u.id, role: 'teacher', staffNumber: 'T' + tag, firstName: first, lastName: last }).returning();
    teachers[tag] = { staffId: st!.id, cookie: `educbt.session=${(await createSession(u.id, null, null)).token}` };
  }
  // Tunde: Mathematics for JSS 1A ONLY (an existing arm-only assignment).
  await db.insert(schema.staffAssignments).values({ schoolId, staffId: teachers['1']!.staffId, classId: classes[0]!.id, subjectId: subjects[0]!.id, assignmentType: 'subject_teacher' });
  // Grace: Mathematics for JSS 1A too (second teacher, same subject and arm) + class teacher of JSS 1A.
  await db.insert(schema.staffAssignments).values([
    { schoolId, staffId: teachers['2']!.staffId, classId: classes[0]!.id, subjectId: subjects[0]!.id, assignmentType: 'subject_teacher' },
    { schoolId, staffId: teachers['2']!.staffId, classId: classes[0]!.id, assignmentType: 'class_teacher' },
  ]);
  // Kemi: Basic Science, JSS 1A.
  await db.insert(schema.staffAssignments).values({ schoolId, staffId: teachers['3']!.staffId, classId: classes[0]!.id, subjectId: subjects[1]!.id, assignmentType: 'subject_teacher' });

  // 6 students in JSS 1A; only 3 take Basic Science (an elective).
  const names = [['Ada', 'Bello'], ['Chidi', 'Okoro'], ['Fatima', 'Yusuf'], ['Emeka', 'Eze'], ['Zainab', 'Musa'], ['Tolu', 'Ajayi']];
  for (let i = 0; i < names.length; i++) {
    const su = await mkUser('student', 's' + i);
    const [st] = await db.insert(schema.students).values({ schoolId, userId: su.id, admissionNumber: 'QA/26/' + String(i + 1).padStart(4, '0'), firstName: names[i]![0]!, lastName: names[i]![1]!, status: 'active', parentName: 'Mr ' + names[i]![1], parentPhone: '0803000000' + i }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId: classes[0]!.id, sessionId: session!.id, status: 'active' });
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: st!.id, subjectId: subjects[0]!.id, sessionId: session!.id });
    if (i < 3) await db.insert(schema.studentSubjects).values({ schoolId, studentId: st!.id, subjectId: subjects[1]!.id, sessionId: session!.id });
  }

  console.log(JSON.stringify({
    schoolId, code, host: 'qa' + code.slice(2).toLowerCase(),
    principalCookie: `educbt.session=${(await createSession(pu.id, null, null)).token}`,
    tunde: teachers['1'], grace: teachers['2'], kemi: teachers['3'],
    classIds: classes.map((c) => c.id), subjectIds: subjects.map((s) => s.id),
  }));
  await owner.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
