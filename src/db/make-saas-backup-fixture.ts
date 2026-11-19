/**
 * Builds a realistic school in a DISPOSABLE local database and writes the platform's real backup file for it, so the WordPress
 * plugin's SaaS-to-plugin tests run against genuine platform output instead of hand-written JSON.
 *   OUT=/tmp/saas-fixture npx tsx src/db/make-saas-backup-fixture.ts
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Fixture needs a disposable local *_ca_test database.');
  const { schema } = await import('@/db');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const out = process.env.OUT ?? '/tmp/saas-fixture';
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const code = 'FX' + randomUUID().slice(0, 5).toUpperCase();
  const { hashPassword: hash } = await import('@/lib/auth/password');   // the platform's own hasher, so the fixture holds real platform hashes

  const [school] = await db.insert(schema.schools).values({ name: 'Fixture College', code, subdomain: code.toLowerCase(), address: '1 Palm Road', settings: {} }).returning();
  const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/2026', isCurrent: true }).returning();
  const [t1, t2] = await db.insert(schema.terms).values([{ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }, { schoolId, sessionId: session!.id, title: 'Second Term', position: 2, isCurrent: false }]).returning();
  const [jss1, ss1] = await db.insert(schema.classLevels).values([{ schoolId, name: 'JSS 1', stage: 'junior', levelOrder: 1 }, { schoolId, name: 'SS 1', stage: 'senior', levelOrder: 2 }]).returning();
  const [sci] = await db.insert(schema.departments).values({ schoolId, name: 'Science', sortOrder: 1 }).returning();
  const [cA, cB] = await db.insert(schema.classes).values([{ schoolId, levelId: jss1!.id, displayName: 'JSS 1 A', arm: 'A', capacity: 40 }, { schoolId, levelId: ss1!.id, departmentId: sci!.id, displayName: 'SS 1 Science', arm: 'Science', capacity: 35 }]).returning();
  const [math, bio] = await db.insert(schema.subjects).values([{ schoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true, category: 'core' }, { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false, departmentId: sci!.id }]).returning();

  const mk = async (role: string, loginId: string, pw: string, email?: string) => (await db.insert(schema.users).values({ schoolId, role: role as never, loginId, passwordHash: await hash(pw), mustChangePassword: false, email: email ?? null }).returning())[0]!;
  const uP = await mk('principal', 'fx/stf/001', 'Principal#1', 'principal@fx.test');
  const uT = await mk('teacher', 'fx/stf/002', 'Teacher#2');
  const [principal] = await db.insert(schema.staff).values({ schoolId, userId: uP.id, role: 'principal', staffNumber: 'FX/STF/001', firstName: 'Ngozi', lastName: 'Eze', email: 'principal@fx.test' }).returning();
  const [teacher] = await db.insert(schema.staff).values({ schoolId, userId: uT.id, role: 'teacher', staffNumber: 'FX/STF/002', firstName: 'Tunde', lastName: 'Bello' }).returning();
  await db.insert(schema.staffAssignments).values([{ schoolId, staffId: teacher!.id, classId: cA!.id, assignmentType: 'class_teacher' }, { schoolId, staffId: teacher!.id, classId: cA!.id, subjectId: math!.id, assignmentType: 'subject_teacher' }]);

  const students: Array<{ id: number; adm: string }> = [];
  for (const [i, [first, mid, last, klass]] of ([['Ada', 'Chioma', 'Obi', cA], ['Musa', null, 'Ibrahim', cA], ['Zainab', 'Aisha', 'Lawal', cB]] as const).entries()) {
    const adm = `FX/26/00${i + 1}`;
    const u = await mk('student', `fx/stu/00${i + 1}`, `Student#${i + 1}`);
    const [s] = await db.insert(schema.students).values({ schoolId, userId: u.id, admissionNumber: adm, firstName: first, middleName: mid, lastName: last, parentName: 'Mr ' + last, parentPhone: '0803000000' + i }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId: klass!.id, sessionId: session!.id });
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: s!.id, subjectId: math!.id, sessionId: session!.id });
    students.push({ id: s!.id, adm });
  }
  const gu = await mk('parent', 'fx/par/001', 'Parent#1', 'parent@fx.test');
  const [guardian] = await db.insert(schema.guardians).values({ schoolId, userId: gu.id, fullName: 'Mrs Chioma Obi', email: 'parent@fx.test', phone: '08030000000' }).returning();
  await db.insert(schema.guardianStudent).values({ schoolId, guardianId: guardian!.id, studentId: students[0]!.id, relationship: 'mother' });
  void t1; void t2; void principal;

  const hashed = await exportSchool(schoolId, { includePasswords: true });
  const plain = await exportSchool(schoolId);
  writeFileSync(`${out}/saas-with-passwords.gz`, hashed.file);
  writeFileSync(`${out}/saas-no-passwords.gz`, plain.file);
  writeFileSync(`${out}/saas-fixture.json`, JSON.stringify({ schoolId, code, students, counts: hashed.counts, passwords: { 'FX/STF/001': 'Principal#1', 'FX/STF/002': 'Teacher#2', 'FX/26/001': 'Student#1', 'FX/26/002': 'Student#2', 'FX/26/003': 'Student#3', 'parent@fx.test': 'Parent#1' } }, null, 2));
  console.log('wrote fixtures; counts', JSON.stringify(hashed.counts));
  await owner.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
