/**
 * Class management integration checks — the plugin's school/classes.php
 * behavior: create arms at once (with restore-on-recreate), inline edit
 * (arm / capacity / department), archive-only removal with its guards, and
 * the capacity gate registration shares. Run with the app-role and owner
 * URLs pointing at a disposable LOCAL database; never at production.
 *   npx tsx src/db/test-classes.ts
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
      throw new Error('Class integration tests require a disposable local *_ca_test database.');
    }
  }
  const { schema, forSchool, client: appClient } = await import('@/db');
  const classes = await import('@/lib/school/classes');
  const students = await import('@/lib/people/students');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const app = postgres(process.env.DATABASE_URL_APP!, { max: 1 });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
    await fn(); count++; console.log('PASS  ' + name);
  };
  const rejects = async (fn: () => unknown | Promise<unknown>, fragment: string) => {
    await assert.rejects(Promise.resolve(fn()), (error: unknown) => error instanceof classes.ClassError
      || error instanceof students.StudentError
      || error instanceof Error && error.message.includes(fragment));
  };

  async function fixture() {
    const code = 'C' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Classes test', code, settings: { assessmentComponents: [] } }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true }).returning();
    const [juniorLevel] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS 1', stage: 'junior', levelOrder: 1 }).returning();
    const [seniorLevel] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS 1', stage: 'senior', levelOrder: 4 }).returning();
    const [science] = await db.insert(schema.departments).values({ schoolId, name: 'Science', sortOrder: 1 }).returning();
    const [principalUser] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'prin-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const [principalStaff] = await db.insert(schema.staff).values({ schoolId, userId: principalUser!.id, role: 'principal', staffNumber: 'P0', firstName: 'Ada', lastName: 'Principal' }).returning();
    const principal: Actor = { schoolId, userId: principalUser!.id, staffId: principalStaff!.id, role: 'principal', loginId: principalUser!.loginId, studentId: null };
    const [teacherUser] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 't-' + code, passwordHash: 'unused', mustChangePassword: false }).returning();
    const teacher: Actor = { schoolId, userId: teacherUser!.id, staffId: null, role: 'teacher', loginId: teacherUser!.loginId, studentId: null };
    return {
      code, schoolId, session: session!, juniorLevel: juniorLevel!, seniorLevel: seniorLevel!,
      science: science!, principal, teacher,
    };
  }

  try {
    await check('runtime role cannot bypass RLS', async () => {
      const [r] = await app`select rolsuper, rolbypassrls from pg_roles where rolname=current_user`;
      assert.equal(r!.rolsuper, false); assert.equal(r!.rolbypassrls, false);
    });

    const a = await fixture();
    const b = await fixture();

    // ── Permissions ─────────────────────────────────────────────────────────
    await check('teacher cannot manage classes', () =>
      rejects(() => classes.createClasses(a.teacher, { levelId: a.juniorLevel.id, arms: 'A' }), 'permission'));
    await check('teacher cannot update a class', () =>
      rejects(() => classes.updateClass(a.teacher, { classId: 1, arm: 'Z', capacity: 0 }), 'permission'));
    await check('teacher cannot remove a class', () =>
      rejects(() => classes.removeClass(a.teacher, 1), 'permission'));

    // ── Create: every arm of a level at once ─────────────────────────────────
    const created = await classes.createClasses(a.principal, { levelId: a.juniorLevel.id, arms: 'a, b c' });
    await check('"a, b c" becomes three uppercased arms', () => {
      assert.equal(created.created.length, 3);
      assert.equal(created.skipped.length, 0);
      assert.deepEqual(created.created, ['JSS 1 A', 'JSS 1 B', 'JSS 1 C']);
    });

    await check('duplicates are skipped, not duplicated', async () => {
      const again = await classes.createClasses(a.principal, { levelId: a.juniorLevel.id, arms: 'A, D' });
      assert.equal(again.created.length, 1);
      assert.equal(again.skipped.length, 1);
      assert.match(again.skipped[0]!, /already exists/);
      assert.equal(again.created[0], 'JSS 1 D');
    });

    await check('an empty arms box makes one unlettered class', async () => {
      const res = await classes.createClasses(a.principal, { levelId: a.seniorLevel.id, arms: '' });
      assert.deepEqual(res.created, ['SS 1']);
    });

    await check('senior classes carry their department in the name', async () => {
      const res = await classes.createClasses(a.principal, { levelId: a.seniorLevel.id, arms: 'A, B', departmentId: a.science.id });
      assert.deepEqual(res.created, ['SS 1 A Science', 'SS 1 B Science']);
    });

    await check('a junior level refuses a department', () =>
      rejects(() => classes.createClasses(a.principal, { levelId: a.juniorLevel.id, arms: 'E', departmentId: a.science.id }), 'senior-school concept'));
    await check('an invalid arm is rejected with a reason', async () => {
      const res = await classes.createClasses(a.principal, { levelId: a.juniorLevel.id, arms: 'ARM4' });
      assert.equal(res.created.length, 0);
      assert.match(res.skipped[0]!, /not a valid arm/);
    });
    await check('an unknown level is rejected', () =>
      rejects(() => classes.createClasses(a.principal, { levelId: 999999, arms: 'A' }), 'could not be found'));

    await check('classes from another school are invisible', async () => {
      const view = await classes.classesView(b.principal);
      assert.equal(view.rows.filter((r) => r.displayName.startsWith('JSS 1')).length, 0);
      assert.equal(view.levels.length, 2); // its own fixture levels only
    });

    // ── Update: arm / capacity / department ─────────────────────────────────
    const [jss1a] = await db.select().from(schema.classes)
      .where(and(eq(schema.classes.schoolId, a.schoolId), eq(schema.classes.displayName, 'JSS 1 A'))).limit(1);
    assert.ok(jss1a);

    await check('editing the arm rebuilds the display name', async () => {
      const res = await classes.updateClass(a.principal, { classId: jss1a!.id, arm: 'q', capacity: 30, departmentId: undefined });
      assert.equal(res.displayName, 'JSS 1 Q');
      const [row] = await db.select().from(schema.classes).where(eq(schema.classes.id, jss1a!.id));
      assert.equal(row!.arm, 'Q');
      assert.equal(row!.capacity, 30);
      assert.equal(row!.displayName, 'JSS 1 Q');
    });

    await check('the edit row refuses a duplicate of a sibling', () =>
      rejects(() => classes.updateClass(a.principal, { classId: jss1a!.id, arm: 'B', capacity: 0 }), 'already exists'));

    await check('capacity cannot be negative', async () => {
      const res = await classes.updateClass(a.principal, { classId: jss1a!.id, arm: 'Q', capacity: -5 });
      assert.equal(res.displayName, 'JSS 1 Q');
      const [row] = await db.select().from(schema.classes).where(eq(schema.classes.id, jss1a!.id));
      assert.equal(row!.capacity, 0);
    });

    // ── Removal guards ───────────────────────────────────────────────────────
    await check('a class with students cannot be removed', async () => {
      const s = await students.registerStudent(a.principal, { firstName: 'Chidi', lastName: 'Okoro', classId: jss1a!.id });
      assert.ok(s.studentId > 0);
      await rejects(() => classes.removeClass(a.principal, jss1a!.id), 'Move them');
    });

    await check('an empty class is archived, and recreating it revives the row', async () => {
      const [jss1d] = await db.select().from(schema.classes)
        .where(and(eq(schema.classes.schoolId, a.schoolId), eq(schema.classes.displayName, 'JSS 1 D'))).limit(1);
      assert.ok(jss1d);
      const removed = await classes.removeClass(a.principal, jss1d!.id);
      assert.equal(removed.name, 'JSS 1 D');
      const [archived] = await db.select().from(schema.classes).where(eq(schema.classes.id, jss1d!.id));
      assert.equal(archived!.status, 'archived');

      // The soft-deleted row still trips the unique key, so recreating the
      // arm revives it instead of failing on a class nobody can see.
      const res = await classes.createClasses(a.principal, { levelId: a.juniorLevel.id, arms: 'D' });
      assert.deepEqual(res.created, ['JSS 1 D']);
      const [revived] = await db.select().from(schema.classes).where(eq(schema.classes.id, jss1d!.id));
      assert.equal(revived!.status, 'active');
    });

    // ── The capacity gate registration shares ───────────────────────────────
    await check('a full class refuses new students', async () => {
      const [jss1c] = await db.select().from(schema.classes)
        .where(and(eq(schema.classes.schoolId, a.schoolId), eq(schema.classes.displayName, 'JSS 1 C'))).limit(1);
      assert.ok(jss1c);
      await classes.updateClass(a.principal, { classId: jss1c!.id, arm: 'C', capacity: 1 });
      const first = await students.registerStudent(a.principal, { firstName: 'Ngozi', lastName: 'Eze', classId: jss1c!.id });
      assert.ok(first.studentId > 0);
      await rejects(() => students.registerStudent(a.principal, { firstName: 'Tola', lastName: 'Ade', classId: jss1c!.id }), 'capacity');
    });

    await check('capacity 0 means no limit', async () => {
      const [jss1b] = await db.select().from(schema.classes)
        .where(and(eq(schema.classes.schoolId, a.schoolId), eq(schema.classes.displayName, 'JSS 1 B'))).limit(1);
      assert.ok(jss1b);
      const many = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          students.registerStudent(a.principal, { firstName: 'Bulk' + i, lastName: 'Kid', classId: jss1b!.id })),
      );
      assert.equal(many.length, 5);
    });

    await check('class teacher shows in the office view', async () => {
      const [jss1q] = await db.select().from(schema.classes)
        .where(and(eq(schema.classes.schoolId, a.schoolId), eq(schema.classes.displayName, 'JSS 1 Q'))).limit(1);
      assert.ok(jss1q);
      // The enrolled student keeps JSS 1 Q occupied; the class teacher column
      // joins staff_assignments — register a teacher holding the class.
      const [tUser] = await db.insert(schema.users).values({ schoolId: a.schoolId, role: 'teacher', loginId: 'ct-' + a.code, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [tStaff] = await db.insert(schema.staff).values({ schoolId: a.schoolId, userId: tUser!.id, role: 'teacher', staffNumber: 'CT1', firstName: 'Grace', lastName: 'Form' }).returning();
      await db.insert(schema.staffAssignments).values({ schoolId: a.schoolId, staffId: tStaff!.id, classId: jss1q!.id, assignmentType: 'class_teacher' });

      const view = await classes.classesView(a.principal);
      const row = view.rows.find((r) => r.displayName === 'JSS 1 Q');
      assert.ok(row);
      assert.equal(row!.classTeacher, 'Grace Form');
      assert.equal(row!.students, 1); // the enrolled Chidi, current session
    });

    console.log(`\nOK: ${count} class-management checks passed.`);
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
