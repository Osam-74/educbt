/**
 * Subject management integration checks — the standard-list seeder, the
 * save/delete handlers and the refresh flow, ported from the legacy plugin's
 * SubjectSeederService. Run against a disposable LOCAL database; never
 * production.
 *   npx tsx src/db/test-subjects.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, sql } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Subjects integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const subjects = await import('@/lib/subjects/service');
  const { STANDARD_SUBJECTS } = await import('@/lib/subjects/standard-list');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const rejects = async (fn: () => unknown | Promise<unknown>, fragment: string) => {
    await assert.rejects(Promise.resolve(fn()), (error: unknown) =>
      error instanceof subjects.SubjectError && error.message.toLowerCase().includes(fragment));
  };

  async function activeCount(schoolId: number) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.subjects)
      .where(and(eq(schema.subjects.schoolId, schoolId), eq(schema.subjects.status, 'active')));
    return row?.n ?? 0;
  }

  async function fixture() {
    const code = 'S' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Subjects test', code }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const departments = await db.insert(schema.departments).values([
      { schoolId, name: 'Science', sortOrder: 1 },
      { schoolId, name: 'Arts and Humanities', sortOrder: 2 },
      { schoolId, name: 'Business/Commercial', sortOrder: 3 },
    ]).returning();
    const [principalUser] = await db.insert(schema.users).values({
      schoolId, role: 'principal', loginId: 'prin-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const principal: Actor = { schoolId, userId: principalUser!.id, staffId: null, role: 'principal', loginId: principalUser!.loginId, studentId: null };
    const [teacherUser] = await db.insert(schema.users).values({
      schoolId, role: 'teacher', loginId: 't-' + code, passwordHash: 'unused', mustChangePassword: false,
    }).returning();
    const teacher: Actor = { schoolId, userId: teacherUser!.id, staffId: null, role: 'teacher', loginId: teacherUser!.loginId, studentId: null };
    return { schoolId, principal, teacher, departments };
  }

  // ── Seeding ──────────────────────────────────────────────────────────────
  {
    const f = await fixture();
    const seeded = await subjects.maybeSeedSubjects(f.schoolId);
    assert.equal(seeded, STANDARD_SUBJECTS.length);
    assert.equal(await activeCount(f.schoolId), STANDARD_SUBJECTS.length);
    await check('maybe-seed loads the full standard list for a fresh school', () => {});

    const again = await subjects.maybeSeedSubjects(f.schoolId);
    assert.equal(again, 0);
    assert.equal(await activeCount(f.schoolId), STANDARD_SUBJECTS.length);
    await check('maybe-seed is a no-op once the list is in place', () => {});

    // Senior subjects attach to matching departments.
    const view = await subjects.subjectsView(f.principal);
    const physics = view.rows.find((r) => r.name === 'Physics');
    const science = f.departments.find((d) => d.name === 'Science')!;
    assert.equal(physics?.departmentId, science.id);
    await check('senior subjects attach to their matching department', () => {});

    // Junior cores are marked compulsory.
    const english = view.rows.find((r) => r.name === 'English Studies');
    assert.equal(english?.isCompulsory, true);
    const lit = view.rows.find((r) => r.name === 'Literature in English');
    assert.equal(lit?.isCompulsory, false);
    await check('core subjects are marked compulsory, electives are not', () => {});
  }

  // ── Seeding respects an existing list ────────────────────────────────────
  {
    const f = await fixture();
    await db.insert(schema.subjects).values({ schoolId: f.schoolId, name: 'Local Custom', code: 'LCU' });
    const seeded = await subjects.maybeSeedSubjects(f.schoolId);
    assert.equal(seeded, 0);
    assert.equal(await activeCount(f.schoolId), 1);
    await check('maybe-seed never fires for a school that already has subjects', () => {});
  }

  // ── Create / edit ─────────────────────────────────────────────────────────
  {
    const f = await fixture();
    await subjects.maybeSeedSubjects(f.schoolId);

    const created = await subjects.saveSubject(f.principal, { name: 'Robotics', code: 'RBT', stage: 'junior' });
    assert.equal(created.code, 'RBT');
    const view = await subjects.subjectsView(f.principal);
    assert(view.rows.some((r) => r.name === 'Robotics'));
    await check('a subject can be created', () => {});

    const auto = await subjects.saveSubject(f.principal, { name: 'Woodwork' });
    assert.equal(auto.code, 'WOOD');
    await check('a missing code is derived from the name', () => {});

    await rejects(() => subjects.saveSubject(f.principal, { name: '' }), 'name');
    await rejects(() => subjects.saveSubject(f.principal, { name: 'Dup', code: 'RBT' }), 'already exists');
    await check('name is required and codes must stay unique per school', async () => {});

    const view2 = await subjects.subjectsView(f.principal);
    const target = view2.rows.find((r) => r.name === 'Robotics')!;
    const updated = await subjects.saveSubject(f.principal, {
      subjectId: target.id, name: 'Robotics Lab', code: 'RBT', stage: 'senior', isCompulsory: true,
    });
    assert.equal(updated.name, 'Robotics Lab');
    const view3 = await subjects.subjectsView(f.principal);
    const after = view3.rows.find((r) => r.id === target.id)!;
    assert.equal(after.name, 'Robotics Lab');
    assert.equal(after.isCompulsory, true);
    assert.equal(after.stage, 'senior');
    await check('a subject can be edited in place through the same handler', () => {});

    await rejects(() => subjects.saveSubject(f.teacher, { name: 'Sneaky' }), 'permission');
    await check('only the principal and vice principal may manage subjects', () => {});

    const vice: Actor = { ...f.principal, role: 'vice_principal' };
    await subjects.saveSubject(vice, { name: 'Vice Subject', code: 'VIC' });
    await check('the vice principal holds MANAGE_SUBJECTS', () => {});
  }

  // ── Delete: unused vs in use ─────────────────────────────────────────────
  {
    const f = await fixture();
    await subjects.maybeSeedSubjects(f.schoolId);

    const unused = await subjects.saveSubject(f.principal, { name: 'Typing', code: 'TYP' });
    const view = await subjects.subjectsView(f.principal);
    const target = view.rows.find((r) => r.code === unused.code)!;
    const removed = await subjects.deleteSubject(f.principal, target.id);
    assert.equal(removed.retired, false);
    const [gone] = await db.select({ id: schema.subjects.id }).from(schema.subjects)
      .where(eq(schema.subjects.id, target.id));
    assert.equal(gone, undefined);
    await check('an unused subject is deleted outright', () => {});

    // A subject carrying a subject_result is retired, not deleted.
    const [session] = await db.insert(schema.academicSessions).values({ schoolId: f.schoolId, title: '2026/27', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId: f.schoolId, sessionId: session!.id, title: 'First', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId: f.schoolId, name: 'SS1' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId: f.schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' }).returning();
    const [studentUser] = await db.insert(schema.users).values({ schoolId: f.schoolId, role: 'student', loginId: 'stu-' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning();
    const [student] = await db.insert(schema.students).values({ schoolId: f.schoolId, userId: studentUser!.id, admissionNumber: 'S/1', firstName: 'Sam', lastName: 'Student', dateOfBirth: new Date('2010-01-01') }).returning();
    const [enrollment] = await db.insert(schema.enrollments).values({ schoolId: f.schoolId, studentId: student!.id, classId: klass!.id, sessionId: session!.id, status: 'active' }).returning();

    const physics = (await subjects.subjectsView(f.principal)).rows.find((r) => r.name === 'Physics')!;
    await db.insert(schema.subjectResults).values({
      schoolId: f.schoolId, studentId: student!.id, subjectId: physics.id, sessionId: session!.id, termId: term!.id,
      total: '70', grade: 'B', subjectPosition: 1,
    });
    const retired = await subjects.deleteSubject(f.principal, physics.id);
    assert.equal(retired.retired, true);
    assert.equal(retired.records, 1);
    const [held] = await db.select({ status: schema.subjects.status }).from(schema.subjects)
      .where(eq(schema.subjects.id, physics.id));
    assert.equal(held?.status, 'retired');
    const viewAfter = await subjects.subjectsView(f.principal);
    assert(!viewAfter.rows.some((r) => r.id === physics.id));
    await check('a subject carrying results is retired, never deleted', () => {});
  }

  // ── Refresh: adopt the standard list deliberately ─────────────────────────
  {
    const f = await fixture();
    // A school that predates the standard list: custom subjects only.
    const custom = await subjects.saveSubject(f.principal, { name: 'Old Custom', code: 'OLD' });
    const inUse = await subjects.saveSubject(f.principal, { name: 'Used Custom', code: 'USED' });

    // Give the used subject a registration record so refresh must retire it.
    const [session] = await db.insert(schema.academicSessions).values({ schoolId: f.schoolId, title: '2026/27', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId: f.schoolId, sessionId: session!.id, title: 'First', position: 1 }).returning();
    const [studentUser] = await db.insert(schema.users).values({ schoolId: f.schoolId, role: 'student', loginId: 'stu-' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning();
    const [student] = await db.insert(schema.students).values({ schoolId: f.schoolId, userId: studentUser!.id, admissionNumber: 'S/1', firstName: 'Ada', lastName: 'Student', dateOfBirth: new Date('2010-01-01') }).returning();
    const viewBefore = await subjects.subjectsView(f.principal);
    const usedId = viewBefore.rows.find((r) => r.code === inUse.code)!.id;
    await db.insert(schema.studentSubjects).values({ schoolId: f.schoolId, studentId: student!.id, subjectId: usedId, sessionId: session!.id });

    const result = await subjects.refreshStandardSubjects(f.principal);
    assert.equal(result.removed, 1); // Old Custom: no history, so deleted
    assert.equal(result.retired, 1); // Used Custom: has history, so retired
    assert.equal(result.added, STANDARD_SUBJECTS.length);
    assert.equal(await activeCount(f.schoolId), STANDARD_SUBJECTS.length);

    const view = await subjects.subjectsView(f.principal);
    assert(!view.rows.some((r) => r.code === custom.code));
    assert(!view.rows.some((r) => r.id === usedId));
    assert(view.standardLoaded);
    await check('refresh removes unused subjects and retires used ones', () => {});

    const [held] = await db.select({ status: schema.subjects.status }).from(schema.subjects)
      .where(eq(schema.subjects.id, usedId));
    assert.equal(held?.status, 'retired');
    await check('the retired custom subject keeps its history readable', () => {});

    await rejects(() => subjects.refreshStandardSubjects(f.teacher), 'permission');
    await check('refresh is capability-gated', () => {});
  }

  // ── Revive: refresh brings retired rows back ──────────────────────────────
  {
    const f = await fixture();
    await subjects.maybeSeedSubjects(f.schoolId);
    const view = await subjects.subjectsView(f.principal);
    const physics = view.rows.find((r) => r.name === 'Physics')!;
    await db.update(schema.subjects).set({ status: 'retired' }).where(eq(schema.subjects.id, physics.id));
    assert.equal((await subjects.subjectsView(f.principal)).rows.length, STANDARD_SUBJECTS.length - 1);
    await check('a retired subject drops out of the active list', () => {});

    await subjects.refreshStandardSubjects(f.principal);
    assert.equal(await activeCount(f.schoolId), STANDARD_SUBJECTS.length);
    const revived = (await subjects.subjectsView(f.principal)).rows.find((r) => r.name === 'Physics');
    assert.ok(revived, 'the retired standard subject is back in the active list');
    await check('refresh brings a retired standard subject back into the active list', () => {});

    // A retired row is revived IN PLACE by the seeder's held-code path — a
    // fresh insert would fail the (school, code) unique key and orphan the
    // records already attached to the old id.

    // Historical school: no active subjects, one retired standard row.
    const f2 = await fixture();
    const [held] = await db.insert(schema.subjects).values({
      schoolId: f2.schoolId, name: 'Physics', code: 'PHY', stage: 'senior', status: 'retired',
    }).returning();
    const seeded = await subjects.maybeSeedSubjects(f2.schoolId);
    assert.equal(seeded, STANDARD_SUBJECTS.length);
    const view2 = await subjects.subjectsView(f2.principal);
    const revived2 = view2.rows.find((r) => r.code === 'PHY');
    assert.equal(revived2?.id, Number(held!.id), 'the held row keeps its id when revived');
    await check('seeding revives a held retired row in place rather than inserting a duplicate', () => {});
  }

  // ── Teachers and filters ──────────────────────────────────────────────────
  {
    const f = await fixture();
    await subjects.maybeSeedSubjects(f.schoolId);
    const view = await subjects.subjectsView(f.principal);
    const maths = view.rows.find((r) => r.name === 'General Mathematics')!;

    const [teacherUser] = await db.insert(schema.users).values({ schoolId: f.schoolId, role: 'teacher', loginId: 'mt-' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false }).returning();
    const [teacherStaff] = await db.insert(schema.staff).values({ schoolId: f.schoolId, userId: teacherUser!.id, role: 'teacher', staffNumber: 'M1', firstName: 'Musa', lastName: 'Maths' }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId: f.schoolId, name: 'SS1' }).returning();
    const [klass] = await db.insert(schema.classes).values({ schoolId: f.schoolId, levelId: level!.id, displayName: 'SS1 A', arm: 'A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId: f.schoolId, staffId: teacherStaff!.id, subjectId: maths.id, classId: klass!.id, assignmentType: 'subject_teacher' });

    const withTeacher = await subjects.subjectsView(f.principal);
    const mathsAfter = withTeacher.rows.find((r) => r.id === maths.id)!;
    assert.equal(mathsAfter.teachers.length, 1);
    assert(mathsAfter.teachers[0]!.name.includes('Musa'));
    assert(mathsAfter.teachers[0]!.classes.includes('SS1 A'));
    await check('the taught-by column lists the teacher and their class', () => {});

    const assigned = await subjects.subjectsView(f.principal, { assigned: 'assigned' });
    assert(assigned.rows.every((r) => r.teachers.length > 0));
    assert(assigned.rows.some((r) => r.id === maths.id));
    const unassigned = await subjects.subjectsView(f.principal, { assigned: 'unassigned' });
    assert(unassigned.rows.every((r) => r.teachers.length === 0));
    await check('the assigned/unassigned filter works', () => {});

    const junior = await subjects.subjectsView(f.principal, { stage: 'junior' });
    assert(junior.rows.every((r) => r.stage === 'junior' || r.stage === 'both'));
    assert(junior.rows.some((r) => r.name === 'English Studies'));
    assert(!junior.rows.some((r) => r.name === 'Physics'));
    await check('the level filter keeps both-level subjects visible', () => {});
  }

  console.log(`\nsubjects: ${count} checks passed`);
  await owner.end();
  await (await import('@/db')).client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
