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
      throw new Error('Assignments/rosters integration tests require a disposable local *_ca_test database.');
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

  async function mkTeacher(a: Awaited<ReturnType<typeof fixture>>, n: string) {
    const [u] = await db.insert(schema.users).values({ schoolId: a.schoolId, role: 'teacher', loginId: n + '-' + a.code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [st] = await db.insert(schema.staff).values({ schoolId: a.schoolId, userId: u!.id, role: 'teacher', staffNumber: n, firstName: n, lastName: 'Tee' }).returning();
    const actor: Actor = { schoolId: a.schoolId, userId: u!.id, staffId: st!.id, role: 'teacher', loginId: u!.loginId, studentId: null };
    return { staffId: st!.id, actor };
  }
  const active = (a: { schoolId: number }, where: ReturnType<typeof and>) =>
    db.select().from(schema.staffAssignments).where(and(eq(schema.staffAssignments.schoolId, a.schoolId), eq(schema.staffAssignments.status, 'active'), where));

  try {
    const a = await fixture();
    const staffSvc = await import('@/lib/people/staff');
    const rosters = await import('@/lib/people/rosters');
    const [A, B] = a.classes as unknown as { id: number }[];
    const MTH = a.subjects[0]!.id, BIO = a.subjects[2]!.id;

    // ── Existing data must survive: a pre-existing whole-level duty. ──────
    const legacy = await mkTeacher(a, 'Legacy');
    await db.insert(schema.staffAssignments).values([
      { schoolId: a.schoolId, staffId: legacy.staffId, classId: A!.id, subjectId: MTH, assignmentType: 'subject_teacher' },
      { schoolId: a.schoolId, staffId: legacy.staffId, classId: B!.id, subjectId: MTH, assignmentType: 'subject_teacher' },
    ]);
    const before = await db.select().from(schema.staffAssignments).where(eq(schema.staffAssignments.schoolId, a.schoolId));

    // ── Two teachers on the SAME subject and the SAME arm ─────────────────
    const t1 = await mkTeacher(a, 'One'), t2 = await mkTeacher(a, 'Two');
    await check('first teacher takes Biology for SS1 A only', async () => {
      const r = await staffSvc.assignBulk(a.principal, 'subject_teacher', [{ staffId: t1.staffId, classIds: [A!.id], subjectIds: [BIO] }]);
      assert.equal(r.saved, 1, JSON.stringify(r));
    });
    await check('a SECOND teacher can take the same subject for the same arm', async () => {
      const r = await staffSvc.assignBulk(a.principal, 'subject_teacher', [{ staffId: t2.staffId, classIds: [A!.id], subjectIds: [BIO] }]);
      assert.equal(r.saved, 1, JSON.stringify(r));
      const rows = await active(a, and(eq(schema.staffAssignments.subjectId, BIO), eq(schema.staffAssignments.classId, A!.id)));
      assert.equal(rows.length, 2);
    });
    await check('an arm-only assignment does NOT spread to the other arm', async () => {
      const rows = await active(a, and(eq(schema.staffAssignments.subjectId, BIO), eq(schema.staffAssignments.classId, B!.id)));
      assert.equal(rows.length, 0);
    });
    await check('both teachers are authorised for their own arm and nothing else', async () => {
      const mine = await rosters.subjectTeacherRoster(t1.actor, A!.id, BIO);
      const theirs = await rosters.subjectTeacherRoster(t2.actor, A!.id, BIO);
      assert.ok(mine && theirs);
      assert.equal(await rosters.subjectTeacherRoster(t1.actor, B!.id, BIO), null); // other arm: refused
    });
    await check('re-saving the same assignment is idempotent (no duplicates)', async () => {
      await staffSvc.assignBulk(a.principal, 'subject_teacher', [{ staffId: t1.staffId, classIds: [A!.id], subjectIds: [BIO] }]);
      const rows = await active(a, and(eq(schema.staffAssignments.staffId, t1.staffId), eq(schema.staffAssignments.subjectId, BIO)));
      assert.equal(rows.length, 1);
    });
    await check('EXISTING assignments are untouched by all of the above', async () => {
      const after = await db.select().from(schema.staffAssignments).where(and(eq(schema.staffAssignments.schoolId, a.schoolId), eq(schema.staffAssignments.staffId, legacy.staffId)));
      const was = before.filter((r) => r.staffId === legacy.staffId);
      assert.equal(after.length, was.length);
      for (const w of was) {
        const n = after.find((r) => r.id === w.id)!;
        assert.equal(n.status, w.status); assert.equal(n.classId, w.classId); assert.equal(n.subjectId, w.subjectId);
      }
    });

    // ── Students with MORE than nine subjects ─────────────────────────────
    const extra = await db.insert(schema.subjects).values(
      Array.from({ length: 12 }, (_, i) => ({ schoolId: a.schoolId, name: 'Elective ' + (i + 1), code: 'X' + (i + 1), isCompulsory: false }))).returning();
    const big = await students.registerStudent(a.principal, { firstName: 'Ada', lastName: 'Obi', gender: 'female', dateOfBirth: '2010-04-01', classId: A!.id });
    await check('a student can hold more than nine subjects (no cap)', async () => {
      const r = await students.setStudentSubjects(a.principal, big.studentId, extra.map((e) => e.id));
      assert.ok(r.total >= 14, 'total ' + r.total);
      const rows = await db.select().from(schema.studentSubjects).where(eq(schema.studentSubjects.studentId, big.studentId));
      assert.ok(rows.length >= 14, 'rows ' + rows.length);
    });

    // ── Rosters ──────────────────────────────────────────────────────────
    const s2 = await students.registerStudent(a.principal, { firstName: '=cmd|calc', lastName: 'Evil, "Quote"', gender: 'male', dateOfBirth: '2010-05-01', classId: A!.id });
    const sB = await students.registerStudent(a.principal, { firstName: 'Bola', lastName: 'Other', gender: 'male', dateOfBirth: '2010-06-01', classId: B!.id });
    await db.insert(schema.studentSubjects).values([
      { schoolId: a.schoolId, studentId: s2.studentId, subjectId: BIO, sessionId: a.session.id },
      { schoolId: a.schoolId, studentId: sB.studentId, subjectId: BIO, sessionId: a.session.id },
    ]).onConflictDoNothing();

    await check('class teacher exports exactly their own class', async () => {
      const r = await rosters.classTeacherRoster(a.teacher, A!.id);
      assert.ok(r);
      const names = r!.students.map((s) => s.firstName);
      assert.ok(names.includes('Ada') && !names.includes('Bola'));
    });
    await check('class teacher cannot export a class they do not head', async () => {
      assert.equal(await rosters.classTeacherRoster(a.teacher, B!.id), null);
    });
    await check('a subject teacher cannot use the class-teacher export', async () => {
      assert.equal(await rosters.classTeacherRoster(t1.actor, A!.id), null);
    });
    await check('subject export lists only students registered for the subject, in that class', async () => {
      const r = await rosters.subjectTeacherRoster(t1.actor, A!.id, BIO);
      assert.ok(r);
      const names = r!.students.map((s) => s.firstName);
      assert.deepEqual(names, ['=cmd|calc']); // Ada (no Biology) and Bola (other class) excluded
    });
    await check('a teacher with no assignment gets nothing, for any class or subject', async () => {
      const nobody = await mkTeacher(a, 'Nobody');
      assert.equal(await rosters.subjectTeacherRoster(nobody.actor, A!.id, BIO), null);
      assert.equal(await rosters.classTeacherRoster(nobody.actor, A!.id), null);
    });
    await check('another school can never be reached through a guessed id', async () => {
      const other = await fixture();
      const o = (other.classes as unknown as { id: number }[])[0]!;
      assert.equal(await rosters.classTeacherRoster(a.teacher, o.id), null);
      assert.equal(await rosters.subjectTeacherRoster(t1.actor, o.id, other.subjects[2]!.id), null);
    });
    await check('CSV: header, BOM, quoting and spreadsheet-formula defence', async () => {
      const r = await rosters.subjectTeacherRoster(t1.actor, A!.id, BIO);
      const csv = rosters.rosterToCsv(r!);
      assert.ok(csv.startsWith('\ufeffNo.,Admission No.,Surname'));
      assert.ok(csv.includes("'=cmd|calc"), 'formula must be defused');
      assert.ok(csv.includes('"Evil, ""Quote"""'), 'commas and quotes escaped');
      assert.ok(!/(^|,)=cmd/m.test(csv), 'no cell may start with =');
    });
    await check('the file name is safe', async () => {
      const f = rosters.rosterFileName({ title: 'Bio/../../x "y"', className: '', subjectName: null, sessionTitle: '2025/26', students: [] });
      assert.match(f, /^[A-Za-z0-9-]+\.csv$/);
    });
    await check('no row cap: a class of 600 exports all 600', async () => {
      const [c] = await db.insert(schema.classes).values({ schoolId: a.schoolId, levelId: (a.classes[0] as { levelId: number }).levelId, displayName: 'SS1 Z', arm: 'Z' }).returning();
      await db.insert(schema.staffAssignments).values({ schoolId: a.schoolId, staffId: a.teacher.staffId!, classId: c!.id, assignmentType: 'class_teacher' });
      const rows = Array.from({ length: 600 }, (_, i) => ({ schoolId: a.schoolId, admissionNumber: 'BULK/' + i, firstName: 'S' + i, lastName: 'Bulk', status: 'active' as const }));
      const made = await db.insert(schema.students).values(rows as never).returning({ id: schema.students.id });
      await db.insert(schema.enrollments).values(made.map((m) => ({ schoolId: a.schoolId, studentId: m.id, classId: c!.id, sessionId: a.session.id, status: 'active' as const })));
      const r = await rosters.classTeacherRoster(a.teacher, c!.id);
      assert.equal(r!.students.length, 600);
    });

    console.log('\n' + count + ' checks passed.');
  } finally {
    for (const id of schoolIds) await db.delete(schema.schools).where(eq(schema.schools.id, id)).catch(() => {});
    await owner.end();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
