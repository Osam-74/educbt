/**
 * Staff + student lifecycle integration checks (Block D: people management).
 * Run with the app-role and owner URLs pointing at a disposable LOCAL
 * database; never at production.
 *   npx tsx src/db/test-people.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('People integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema, forSchool, client: appClient } = await import('@/db');
  const staff = await import('@/lib/people/staff');
  const students = await import('@/lib/people/students');
  const { hashPassword, verifyPassword } = await import('@/lib/auth/password');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const app = postgres(process.env.DATABASE_URL_APP!, { max: 1 });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const rejects = async (fn: () => unknown | Promise<unknown>, fragment: string) => {
    await assert.rejects(Promise.resolve(fn()), (error: unknown) => error instanceof staff.StaffError
      || error instanceof students.StudentError
      || error instanceof Error && error.message.includes(fragment));
  };

  async function fixture() {
    const code = 'P' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'People test', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2025/26', isCurrent: true }).returning();
    const [oldSession] = await db.insert(schema.academicSessions).values({ schoolId, title: '2024/25' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1' }).returning();
    const classes = await db.insert(schema.classes).values([
      { schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' },
      { schoolId, levelId: level!.id, displayName: 'SS1 B', arm: 'B' },
    ]).returning();
    const subjects = await db.insert(schema.subjects).values([
      { schoolId, name: 'Maths', code: 'MTH', isCompulsory: true },
      { schoolId, name: 'Biology', code: 'BIO', isCompulsory: false },
      { schoolId, name: 'Chemistry', code: 'CHM', isCompulsory: false },
    ]).returning();

    // The office: a principal. Actors are built straight from inserted rows;
    // the services under test treat the Actor as the authenticated identity.
    const [principalUser] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'prin-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [principalStaff] = await db.insert(schema.staff).values({ schoolId, userId: principalUser!.id, role: 'principal', staffNumber: 'P0', firstName: 'Ada', lastName: 'Principal' }).returning();
    const principal: Actor = { schoolId, userId: principalUser!.id, staffId: principalStaff!.id, role: 'principal', loginId: principalUser!.loginId, studentId: null };

    // A class teacher who holds SS1 A only.
    const [teacherUser] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 't-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [teacherStaff] = await db.insert(schema.staff).values({ schoolId, userId: teacherUser!.id, role: 'teacher', staffNumber: 'T0', firstName: 'Tunde', lastName: 'Teacher' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacherStaff!.id, classId: classes[0]!.id, assignmentType: 'class_teacher' });
    const teacher: Actor = { schoolId, userId: teacherUser!.id, staffId: teacherStaff!.id, role: 'teacher', loginId: teacherUser!.loginId, studentId: null };

    // An exam officer: school-wide for results, but not for staff management.
    const [eoUser] = await db.insert(schema.users).values({ schoolId, role: 'exam_officer', loginId: 'eo-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const eo: Actor = { schoolId, userId: eoUser!.id, staffId: null, role: 'exam_officer', loginId: eoUser!.loginId, studentId: null };

    return { code, schoolId, session: session!, oldSession: oldSession!, term: term!, classes: classes as typeof classes & { id: number }[], subjects, principal, teacher, eo };
  }

  try {
    await check('runtime role cannot bypass RLS', async () => {
      const [r] = await app`select rolsuper, rolbypassrls from pg_roles where rolname=current_user`;
      assert.equal(r!.rolsuper, false); assert.equal(r!.rolbypassrls, false);
    });

    const a = await fixture();
    const b = await fixture();

    // ── Staff registration ──────────────────────────────────────────────────
    await check('exam officer cannot register staff', () =>
      rejects(() => staff.registerStaff(a.eo, { firstName: 'No', lastName: 'Way', role: 'teacher' }), 'permission'));

    const first = await staff.registerStaff(a.principal, { firstName: 'Grace', lastName: 'Okafor', title: 'Mrs', gender: 'female', email: 'g.okafor@example.com', role: 'teacher' });
    await check('staff numbers follow CODE/STF/NNN', () => {
      assert.match(first.staffNumber, new RegExp(`^${a.code}/STF/\\d{3,4}$`));
    });
    await check('login is the staff number (slashes become dots) with a temporary password', async () => {
      assert.equal(first.loginId, first.staffNumber.replace(/\//g, '.'));
      const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, first.loginId));
      assert.ok(user);
      assert.equal(user!.mustChangePassword, true);
      assert.equal(await verifyPassword(user!.passwordHash, first.temporaryPassword), true);
      assert.equal(await verifyPassword(user!.passwordHash, 'wrong'), false);
    });
    const second = await staff.registerStaff(a.principal, { firstName: 'John', lastName: 'Bello', role: 'teacher' });
    await check('the next staff number increments', () => {
      assert.equal(Number(second.staffNumber.split('/').pop()), Number(first.staffNumber.split('/').pop()) + 1);
    });
    await check('blank names rejected', () =>
      rejects(() => staff.registerStaff(a.principal, { firstName: '  ', lastName: 'B', role: 'teacher' }), 'first name and a surname'));
    await check('invalid email rejected', () =>
      rejects(() => staff.registerStaff(a.principal, { firstName: 'Xx', lastName: 'Yy', email: 'nope', role: 'teacher' }), 'email'));
    await check('a second principal is refused outright', () =>
      rejects(() => staff.registerStaff(a.principal, { firstName: 'Second', lastName: 'Principal', role: 'principal' }), 'principal'));

    // ── Principal transfer ──────────────────────────────────────────────────
    await check('principal transfer requires confirmation', () =>
      rejects(() => staff.updateStaff(a.principal, {
        staffId: second.staffId, firstName: 'John', lastName: 'Bello', role: 'principal',
      }), 'confirm'));
    await staff.updateStaff(a.principal, {
      staffId: second.staffId, firstName: 'John', lastName: 'Bello', role: 'principal', confirmTransfer: true,
    });
    await check('transfer demotes the old principal to vice principal', async () => {
      const [old] = await db.select().from(schema.staff).where(eq(schema.staff.id, a.principal.staffId!));
      assert.equal(old!.role, 'vice_principal');
      const [now] = await db.select().from(schema.staff).where(eq(schema.staff.id, second.staffId));
      assert.equal(now!.role, 'principal');
    });
    // Give fixture a's principal their role back for the later checks.
    await staff.updateStaff(a.principal, { staffId: a.principal.staffId!, firstName: 'Ada', lastName: 'Principal', role: 'principal', confirmTransfer: true });

    // ── Assignments ──────────────────────────────────────────────────────────
    const assignResult = await staff.assignBulk(a.principal, 'class_teacher', [
      { staffId: first.staffId, classIds: [a.classes[0]!.id], subjectIds: [] },
    ]);
    await check('class teacher assignment saves', () => assert.equal(assignResult.saved, 1));
    await staff.assignBulk(a.principal, 'class_teacher', [
      { staffId: second.staffId, classIds: [a.classes[0]!.id], subjectIds: [] },
    ]);
    await check('second class teacher replaces the first', async () => {
      const rows = await db.select().from(schema.staffAssignments).where(and(
        eq(schema.staffAssignments.schoolId, a.schoolId),
        eq(schema.staffAssignments.classId, a.classes[0]!.id),
        eq(schema.staffAssignments.assignmentType, 'class_teacher'),
        eq(schema.staffAssignments.status, 'active'),
      ));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.staffId, second.staffId);
      // ...and the outgoing teacher's row is retired, not deleted — history of
      // the handover survives.
      const retired = await db.select().from(schema.staffAssignments).where(and(
        eq(schema.staffAssignments.classId, a.classes[0]!.id),
        eq(schema.staffAssignments.assignmentType, 'class_teacher'),
      ));
      assert.ok(retired.some((r) => r.status === 'replaced'));
    });
    const bulk = await staff.assignBulk(a.principal, 'subject_teacher', [
      { staffId: first.staffId, classIds: [a.classes[0]!.id, a.classes[1]!.id], subjectIds: [a.subjects[0]!.id, a.subjects[2]!.id] },
    ]);
    await check('one save stores a cross product of duties', () => assert.equal(bulk.saved, 4));
    await check('teacher cannot assign duties', () =>
      rejects(() => staff.assignBulk(a.teacher, 'subject_teacher', [
        { staffId: first.staffId, classIds: [a.classes[0]!.id], subjectIds: [a.subjects[0]!.id] },
      ]), 'permission'));
    await check('foreign class rejected', () =>
      rejects(() => staff.assignBulk(a.principal, 'subject_teacher', [
        { staffId: first.staffId, classIds: [b.classes[0]!.id], subjectIds: [] },
      ]), 'could not be found'));

    // ── Password reset and stand-down ────────────────────────────────────────
    const [beforeUser] = await db.select().from(schema.users).where(eq(schema.users.loginId, first.loginId));
    await db.insert(schema.sessions).values({ id: 'sess-people-1', userId: beforeUser!.id, expiresAt: new Date(Date.now() + 86400000) });
    const reset = await staff.resetStaffPassword(a.principal, first.staffId);
    await check('password reset verifies and revokes sessions', async () => {
      const [afterUser] = await db.select().from(schema.users).where(eq(schema.users.loginId, first.loginId));
      assert.equal(await verifyPassword(afterUser!.passwordHash, reset.temporaryPassword), true);
      const sessions = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, beforeUser!.id));
      assert.equal(sessions.length, 0);
      assert.equal(afterUser!.mustChangePassword, true);
    });
    await check('teacher cannot reset another staff password', () =>
      rejects(() => staff.resetStaffPassword(a.teacher, second.staffId), 'permission'));

    await check('stand-down without confirmation refuses', () =>
      rejects(() => staff.standDownStaff(a.principal, first.staffId, false), 'confirm'));
    const stoodDown = await staff.standDownStaff(a.principal, first.staffId, true);
    await check('stand-down releases duties and disables the login', async () => {
      const [row] = await db.select().from(schema.staff).where(eq(schema.staff.id, first.staffId));
      assert.equal(row!.status, 'left');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, first.loginId));
      assert.equal(user!.status, 'disabled');
      assert.ok(stoodDown.released.length >= 4); // 4 subject pairs (their class-teacher duty was replaced earlier)
      const duties = await db.select().from(schema.staffAssignments).where(and(
        eq(schema.staffAssignments.staffId, first.staffId), eq(schema.staffAssignments.status, 'active')));
      assert.equal(duties.length, 0);
    });
    await staff.reactivateStaff(a.principal, first.staffId);
    await check('reactivation restores the login', async () => {
      const [row] = await db.select().from(schema.staff).where(eq(schema.staff.id, first.staffId));
      assert.equal(row!.status, 'active');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, first.loginId));
      assert.equal(user!.status, 'active');
    });

    // ── Student registration ─────────────────────────────────────────────────
    await check('teacher cannot register into a class they do not hold', () =>
      rejects(() => students.registerStudent(a.teacher, {
        firstName: 'Ada', lastName: 'Obi', classId: a.classes[1]!.id,
      }), 'class you hold'));

    const s1 = await students.registerStudent(a.principal, {
      firstName: 'Ada', lastName: 'Obi', gender: 'female', dateOfBirth: '2010-04-01', classId: a.classes[0]!.id,
    });
    await check('admission numbers follow CODE/YEAR/0001 and academic year', () => {
      assert.match(s1.admissionNumber, new RegExp(`^${a.code}/\\d{4}/\\d{4}$`));
    });
    await check('initial password is the surname and change is forced', async () => {
      assert.equal(s1.initialPassword, 'obi00000');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, s1.loginId));
      assert.equal(await verifyPassword(user!.passwordHash, 'obi00000'), true);
      assert.equal(user!.mustChangePassword, true);
    });
    await check('registration enrols the student in the current session', async () => {
      const rows = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, s1.studentId));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.sessionId, a.session.id);
      assert.equal(rows[0]!.classId, a.classes[0]!.id);
      assert.equal(rows[0]!.status, 'active');
    });
    const s2 = await students.registerStudent(a.principal, { firstName: 'Bo', lastName: 'Adeyemi', classId: a.classes[1]!.id });
    await check('the next admission number increments', () =>
      assert.equal(Number(s2.admissionNumber.split('/').pop()), Number(s1.admissionNumber.split('/').pop()) + 1));
    await check('duplicate supplied admission numbers rejected', () =>
      rejects(() => students.registerStudent(a.principal, {
        firstName: 'Clone', lastName: 'Obi', admissionNumber: s1.admissionNumber, classId: a.classes[0]!.id,
      }), 'already in use'));
    const custom = await students.registerStudent(a.principal, {
      firstName: 'Cara', lastName: 'Nwosu', admissionNumber: 'MY/OWN/77', classId: a.classes[0]!.id,
    });
    await check('a school-supplied admission number is kept as the login', () => {
      assert.equal(custom.admissionNumber, 'MY/OWN/77');
      assert.equal(custom.loginId, 'MY/OWN/77');
    });
    await check('short surnames pad the initial password', async () => {
      const s = await students.registerStudent(a.principal, { firstName: 'Dele', lastName: 'Ojo', classId: a.classes[0]!.id });
      assert.equal(s.initialPassword, 'ojo00000');
    });
    await check('future date of birth rejected', () =>
      rejects(() => students.registerStudent(a.principal, {
        firstName: 'Err', lastName: 'Or', dateOfBirth: '2999-01-01', classId: a.classes[0]!.id,
      }), 'future'));

    // ── Class-teacher pending-approval flow ──────────────────────────────────
    // The teacher's class A duty was handed over mid-test (see the replacement
    // check above); give it back so the pending-approval flow runs against a
    // class they hold.
    await staff.assignBulk(a.principal, 'class_teacher', [
      { staffId: a.teacher.staffId!, classIds: [a.classes[0]!.id], subjectIds: [] },
    ]);
    const pending = await students.registerStudent(a.teacher, {
      firstName: 'Teacher', lastName: 'Added', classId: a.classes[0]!.id,
    });
    await check('class teacher additions await approval', async () => {
      assert.equal(pending.pendingApproval, true);
      const [st] = await db.select().from(schema.students).where(eq(schema.students.id, pending.studentId));
      assert.equal(st!.status, 'pending_approval');
      const [en] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, pending.studentId));
      assert.equal(en!.status, 'pending_approval');
    });
    await check('teacher cannot approve their own addition', () =>
      rejects(() => students.approveStudent(a.teacher, pending.studentId), 'office'));
    await students.approveStudent(a.principal, pending.studentId);
    await check('approval flips student and enrolment to active', async () => {
      const [st] = await db.select().from(schema.students).where(eq(schema.students.id, pending.studentId));
      assert.equal(st!.status, 'active');
      const [en] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, pending.studentId));
      assert.equal(en!.status, 'active');
    });

    // ── Moving and history ───────────────────────────────────────────────────
    await db.insert(schema.enrollments).values({
      schoolId: a.schoolId, studentId: s1.studentId, classId: a.classes[1]!.id, sessionId: a.oldSession.id,
    });
    await students.moveStudent(a.principal, s1.studentId, a.classes[1]!.id);
    await check('a move updates the current session only', async () => {
      const rows = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, s1.studentId));
      const current = rows.find((r) => r.sessionId === a.session.id);
      const past = rows.find((r) => r.sessionId === a.oldSession.id);
      assert.equal(current!.classId, a.classes[1]!.id);
      assert.equal(past!.classId, a.classes[1]!.id); // untouched by the move
    });
    await check('a teacher cannot move a student they do not teach', () =>
      rejects(() => students.moveStudent(a.teacher, s2.studentId, a.classes[0]!.id), 'permission'));
    const heldStudent = await students.registerStudent(a.teacher, { firstName: 'Held', lastName: 'One', classId: a.classes[0]!.id });
    await students.approveStudent(a.principal, heldStudent.studentId);
    // A class teacher may only move a student INTO a class they hold, so give
    // them class B for the duration of this one check, then take it back.
    const [bDuty] = await db.insert(schema.staffAssignments).values({
      schoolId: a.schoolId, staffId: a.teacher.staffId!, classId: a.classes[1]!.id, assignmentType: 'class_teacher',
    }).returning();
    await students.moveStudent(a.teacher, heldStudent.studentId, a.classes[1]!.id);
    await check('a class teacher CAN move their own student between held classes', async () => {
      const rows = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, heldStudent.studentId));
      assert.equal(rows[0]!.classId, a.classes[1]!.id);
    });
    await db.delete(schema.staffAssignments).where(eq(schema.staffAssignments.id, bDuty!.id));

    // ── Standing ─────────────────────────────────────────────────────────────
    await check('teacher cannot change standing', () =>
      rejects(() => students.setStudentStanding(a.teacher, s2.studentId, 'suspended'), 'office'));
    await students.setStudentStanding(a.principal, s2.studentId, 'suspended');
    await check('suspension disables the login but keeps the class place', async () => {
      const [st] = await db.select().from(schema.students).where(eq(schema.students.id, s2.studentId));
      assert.equal(st!.status, 'suspended');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, s2.loginId));
      assert.equal(user!.status, 'disabled');
      const [en] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, s2.studentId));
      assert.equal(en!.status, 'active');
    });
    await students.setStudentStanding(a.principal, s2.studentId, 'withdrawn');
    await check('withdrawal also ends the enrolment', async () => {
      const [st] = await db.select().from(schema.students).where(eq(schema.students.id, s2.studentId));
      assert.equal(st!.status, 'withdrawn');
      const [en] = await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, s2.studentId));
      assert.equal(en!.status, 'inactive');
    });
    await students.setStudentStanding(a.principal, s2.studentId, 'active');
    await check('reactivation restores login and enrolment', async () => {
      const [st] = await db.select().from(schema.students).where(eq(schema.students.id, s2.studentId));
      assert.equal(st!.status, 'active');
      const [user] = await db.select().from(schema.users).where(eq(schema.users.loginId, s2.loginId));
      assert.equal(user!.status, 'active');
    });

    // ── Password reset (students) ────────────────────────────────────────────
    // The move test left this student in class B, outside the teacher's reach;
    // the office moves them back so the reset runs against a held student.
    await students.moveStudent(a.principal, heldStudent.studentId, a.classes[0]!.id);
    await students.resetStudentPassword(a.teacher, heldStudent.studentId);
    await check('a class teacher resets their own student to the surname password', async () => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, (await db.select().from(schema.students).where(eq(schema.students.id, heldStudent.studentId)))[0]!.userId!));
      assert.equal(await verifyPassword(user!.passwordHash, 'one00000'), true);
      assert.equal(user!.mustChangePassword, true);
    });
    await check('reset is refused outside the teacher\'s classes', () =>
      rejects(() => students.resetStudentPassword(a.teacher, s2.studentId), 'permission'));

    // ── Guardians ────────────────────────────────────────────────────────────
    await check('teacher cannot link guardians', () =>
      rejects(() => students.linkGuardian(a.teacher, heldStudent.studentId, {
        fullName: 'Mrs Parent', email: 'parent@example.com',
      }), 'office'));
    const g1 = await students.linkGuardian(a.principal, heldStudent.studentId, {
      fullName: 'Mrs Parent', email: 'parent@example.com', relationship: 'mother',
    });
    await check('a guardian invite token is issued once', () => {
      assert.ok(g1.created);
      assert.match(g1.inviteToken, /^[A-Za-z0-9_-]{20,}$/);
    });
    const g2 = await students.linkGuardian(a.principal, s2.studentId, {
      fullName: 'Mrs Parent', email: 'parent@example.com', relationship: 'mother',
    });
    await check('the same email deduplicates to one guardian with two links', async () => {
      assert.equal(g2.created, false);
      assert.equal(g2.guardianId, g1.guardianId);
      const links = await db.select().from(schema.guardianStudent).where(eq(schema.guardianStudent.guardianId, g1.guardianId));
      assert.equal(links.length, 2);
    });
    await check('a guardian needs a name and a contact', () => {
      return rejects(() => students.linkGuardian(a.principal, heldStudent.studentId, { fullName: '' }), 'name');
    });

    // ── Subject registration ────────────────────────────────────────────────
    await check('registration needs a current enrolment', () =>
      rejects(() => students.setStudentSubjects(a.principal, custom.studentId, [a.subjects[1]!.id]), 'no current enrolment')
        .catch(() => { throw new Error('expected rejection'); })
        .catch(async (e) => {
          // custom IS enrolled; use an unenrolled student instead
          const s = await students.registerStudent(a.principal, { firstName: 'Un', lastName: 'Enrolled', classId: a.classes[0]!.id });
          await db.delete(schema.enrollments).where(eq(schema.enrollments.studentId, s.studentId));
          await rejects(() => students.setStudentSubjects(a.principal, s.studentId, [a.subjects[1]!.id]), 'no current enrolment');
        }));
    const view1 = await students.subjectRegistrationView(a.principal, heldStudent.studentId);
    await check('the view separates compulsory from electives', () => {
      assert.equal(view1.core.length, 1); // Maths
      assert.equal(view1.electives.length, 2);
      assert.equal(view1.registered.length, 0);
    });
    const setResult = await students.setStudentSubjects(a.principal, heldStudent.studentId, [a.subjects[1]!.id, 999999]);
    await check('compulsory plus chosen electives register; unknown ids are ignored', async () => {
      assert.equal(setResult.total, 2);
      const rows = await db.select().from(schema.studentSubjects).where(eq(schema.studentSubjects.studentId, heldStudent.studentId));
      const ids = rows.map((r) => r.subjectId).sort();
      assert.deepEqual(ids, [a.subjects[0]!.id, a.subjects[1]!.id].sort((x, y) => x - y));
    });
    // Marks pin the subject: Biology now has CA for this student.
    await db.insert(schema.assessmentScores).values({
      schoolId: a.schoolId, studentId: heldStudent.studentId, subjectId: a.subjects[1]!.id,
      sessionId: a.session.id, termId: a.term.id, componentKey: 'ca1', score: '15', maxScore: '20',
    });
    const dropped = await students.setStudentSubjects(a.principal, heldStudent.studentId, []);
    await check('a subject with marks cannot be dropped', () => {
      assert.equal(dropped.droppedProtected, 0);
      assert.equal(dropped.total, 2); // Maths (core) + Biology (pinned)
    });

    // ── Photo store ──────────────────────────────────────────────────────────
    const { savePassportPhoto, photoUrlFor } = await import('@/lib/people/photos');
    const url = await savePassportPhoto(a.principal, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'photo.png', { type: 'image/png' }));
    await check('a passport photo is stored behind an unguessable token', () => {
      assert.match(url ?? '', /^\/api\/photos\/[A-Za-z0-9_-]{32,}$/);
    });
    const token = (url ?? '').split('/').pop()!;
    await check('the serve route can read the photo without a school context', async () => {
      const rows = await app`select mime_type from portal_uploads where token = ${token}`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.mime_type, 'image/png');
    });
    await check('photo writes stay tenant-scoped', async () => {
      // The app role cannot INSERT portal_uploads without a school context.
      await assert.rejects(() => app`insert into portal_uploads (school_id, token, mime_type, byte_size, data) values (${a.schoolId}, ${'forbidden-' + randomUUID()}, 'image/png', 4, '\x89PNG')`);
    });
    await check('oversized photos rejected', async () => {
      const big = new File([new Uint8Array(1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
      await rejects(() => savePassportPhoto(a.principal, big), '1 MB');
    });
    await check('non-image types rejected', async () => {
      const doc = new File([new Uint8Array(8)], 'doc.pdf', { type: 'application/pdf' });
      await rejects(() => savePassportPhoto(a.principal, doc), 'JPEG');
    });

    console.log(`\nOK: ${count} people-management checks passed.`);
  } finally {
    await appClient?.end?.();
    await owner.end();
    await app.end();
    for (const id of schoolIds) {
      await drizzle(postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 }), { schema })
        .delete(schema.schools).where(eq(schema.schools.id, id));
      await postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 }).end();
    }
  }
}

main().then(() => { process.exit(0); }).catch((error) => { console.error('FAIL  ' + (error instanceof Error ? error.message : error)); process.exit(1); });
