/**
 * Subject Registration integration checks — the class teacher's "register
 * everyone's compulsory subjects in one go" bulk action, and the roster
 * that shows how many subjects each student has for the current session.
 * Ported from the legacy plugin's teacher/registration.php.
 *   npx tsx src/db/test-registration.ts
 * Run against a disposable LOCAL database; never production.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Registration integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const students = await import('@/lib/people/students');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const rejects = async (fn: () => unknown | Promise<unknown>, fragment: string) => {
    await assert.rejects(Promise.resolve(fn()), (error: unknown) =>
      error instanceof students.StudentError && error.message.toLowerCase().includes(fragment));
  };

  async function fixture() {
    const code = 'R' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Registration test', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1' }).returning();
    const classes = await db.insert(schema.classes).values([
      { schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' },
      { schoolId, levelId: level!.id, displayName: 'SS1 B', arm: 'B' },
    ]).returning();
    const subjects = await db.insert(schema.subjects).values([
      { schoolId, name: 'Maths', code: 'MTH', isCompulsory: true },
      { schoolId, name: 'English', code: 'ENG', isCompulsory: true },
      { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false },
    ]).returning();

    const [principalUser] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'prin-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [principalStaff] = await db.insert(schema.staff).values({ schoolId, userId: principalUser!.id, role: 'principal', staffNumber: 'P0', firstName: 'Ada', lastName: 'Principal' }).returning();
    const principal: Actor = { schoolId, userId: principalUser!.id, staffId: principalStaff!.id, role: 'principal', loginId: principalUser!.loginId, studentId: null };

    // A class teacher who holds SS1 A only — not SS1 B.
    const [teacherUser] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 't-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [teacherStaff] = await db.insert(schema.staff).values({ schoolId, userId: teacherUser!.id, role: 'teacher', staffNumber: 'T0', firstName: 'Tunde', lastName: 'Teacher' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacherStaff!.id, classId: classes[0]!.id, assignmentType: 'class_teacher' });
    const teacher: Actor = { schoolId, userId: teacherUser!.id, staffId: teacherStaff!.id, role: 'teacher', loginId: teacherUser!.loginId, studentId: null };

    return { code, schoolId, session: session!, classes: classes as typeof classes & { id: number }[], subjects, principal, teacher };
  }

  try {
    const a = await fixture();

    const s1 = await students.registerStudent(a.principal, {
      firstName: 'Ada', lastName: 'Obi', gender: 'female', dateOfBirth: '2010-04-01', classId: a.classes[0]!.id,
    });
    const s2 = await students.registerStudent(a.principal, {
      firstName: 'Bayo', lastName: 'Ige', gender: 'male', dateOfBirth: '2010-05-01', classId: a.classes[0]!.id,
    });
    // Give s2 one of the two compulsory subjects up front, to prove the bulk
    // action tops up the rest without duplicating what's already there.
    await db.insert(schema.studentSubjects).values({ schoolId: a.schoolId, studentId: s2.studentId, subjectId: a.subjects[0]!.id, sessionId: a.session.id });
    const sOther = await students.registerStudent(a.principal, {
      firstName: 'Chidi', lastName: 'Eze', gender: 'male', dateOfBirth: '2010-06-01', classId: a.classes[1]!.id,
    });

    await check('a teacher not holding the class is refused', () =>
      rejects(() => students.registerCoreForClass(a.teacher, a.classes[1]!.id), 'not the class teacher'));

    await check('the roster is empty for a class the teacher does not hold', async () => {
      const roster = await students.classRegistrationRoster(a.teacher, a.classes[1]!.id);
      assert.deepEqual(roster.rows, []);
    });

    await check('before registering, the roster shows zero subjects registered', async () => {
      const roster = await students.classRegistrationRoster(a.teacher, a.classes[0]!.id);
      assert.equal(roster.coreCount, 2);
      const ada = roster.rows.find((r) => r.id === s1.studentId);
      const bayo = roster.rows.find((r) => r.id === s2.studentId);
      assert.equal(ada?.registeredCount, 0);
      assert.equal(bayo?.registeredCount, 1);
    });

    const result = await students.registerCoreForClass(a.teacher, a.classes[0]!.id);
    await check('the bulk action reports how many students were touched', () => {
      assert.equal(result.coreCount, 2);
      assert.equal(result.studentsUpdated, 2);
      assert.equal(result.alreadyComplete, 0);
    });

    await check('every student in the class now has both compulsory subjects', async () => {
      const rows = await db.select().from(schema.studentSubjects).where(eq(schema.studentSubjects.studentId, s1.studentId));
      assert.equal(rows.length, 2);
      assert.deepEqual(new Set(rows.map((r) => r.subjectId)), new Set([a.subjects[0]!.id, a.subjects[1]!.id]));

      const bayoRows = await db.select().from(schema.studentSubjects).where(eq(schema.studentSubjects.studentId, s2.studentId));
      assert.equal(bayoRows.length, 2); // no duplicate of the one they already had
    });

    await check('a student in another class is untouched', async () => {
      const rows = await db.select().from(schema.studentSubjects).where(eq(schema.studentSubjects.studentId, sOther.studentId));
      assert.equal(rows.length, 0);
    });

    await check('re-running the bulk action reports everyone already complete', async () => {
      const again = await students.registerCoreForClass(a.teacher, a.classes[0]!.id);
      assert.equal(again.studentsUpdated, 2);
      assert.equal(again.alreadyComplete, 2);
    });

    await check('running it against a school with no compulsory subjects reports zero', async () => {
      const b = await fixture();
      await db.update(schema.subjects).set({ isCompulsory: false }).where(eq(schema.subjects.schoolId, b.schoolId));
      const empty = await students.registerCoreForClass(b.principal, b.classes[0]!.id);
      assert.equal(empty.coreCount, 0);
      assert.equal(empty.studentsUpdated, 0);
    });

    await check('the audit log records the bulk registration', async () => {
      const [row] = await db.select().from(schema.auditLog).where(and(
        eq(schema.auditLog.schoolId, a.schoolId),
        eq(schema.auditLog.action, 'student.core_subjects_registered_bulk'),
      ));
      assert.ok(row);
    });

    console.log(`\n${count} registration checks passed.`);
  } finally {
    for (const schoolId of schoolIds) {
      await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    }
    await owner.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
