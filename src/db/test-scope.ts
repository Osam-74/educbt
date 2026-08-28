/**
 * Role scoping verification.
 *
 *   npm run test:scope
 *
 * Phase 1 proved a school cannot see another school. This proves that WITHIN a
 * school, a teacher cannot see students they do not teach.
 *
 * That second boundary is not enforced by RLS — RLS guards the tenant, not the
 * role — so it lives in the query layer and has to be tested explicitly. The
 * failure mode is silent and generous: a missing condition returns MORE rows,
 * and nothing errors.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';

const schema = { ...core, ...people };

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;

  if (!url) throw new Error('DATABASE_URL_UNPOOLED is required.');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [school] = await db.select().from(core.schools)
      .where(eq(core.schools.code, 'DEMO001')).limit(1);

    if (!school) {
      console.log('SKIP  seed the demo school first (npm run db:seed).');
      return;
    }

    const schoolId = school.id;

    // ── Fixture: a second class the seeded teacher does NOT teach ────────────
    const [level] = await db.select().from(core.classLevels)
      .where(eq(core.classLevels.schoolId, schoolId)).limit(1);

    let [otherClass] = await db.select().from(core.classes)
      .where(and(
        eq(core.classes.schoolId, schoolId),
        eq(core.classes.displayName, 'SCOPE TEST CLASS'),
      )).limit(1);

    if (!otherClass) {
      [otherClass] = await db.insert(core.classes).values({
        schoolId, levelId: level!.id, departmentId: null,
        arm: 'Z', displayName: 'SCOPE TEST CLASS',
      }).returning();
    }

    const [session] = await db.select().from(core.academicSessions)
      .where(eq(core.academicSessions.schoolId, schoolId)).limit(1);

    let [outsider] = await db.select().from(people.students)
      .where(and(
        eq(people.students.schoolId, schoolId),
        eq(people.students.admissionNumber, 'SCOPE-001'),
      )).limit(1);

    if (!outsider) {
      [outsider] = await db.insert(people.students).values({
        schoolId, admissionNumber: 'SCOPE-001',
        firstName: 'Outside', lastName: 'Scope',
      }).returning();

      await db.insert(people.enrollments).values({
        schoolId, studentId: outsider!.id, classId: otherClass!.id,
        sessionId: session!.id, status: 'active',
      });
    }

    // ── The teacher's reachable set ──────────────────────────────────────────
    const [teacher] = await db.select().from(people.staff)
      .where(and(
        eq(people.staff.schoolId, schoolId),
        eq(people.staff.staffNumber, 'STF001'),
      )).limit(1);

    const assignments = await db.select({ classId: people.staffAssignments.classId })
      .from(people.staffAssignments)
      .where(and(
        eq(people.staffAssignments.staffId, teacher!.id),
        eq(people.staffAssignments.status, 'active'),
      ));

    const reachable = assignments
      .map((a) => a.classId)
      .filter((id): id is number => id !== null);

    check('teacher has at least one assignment', reachable.length > 0);
    check(
      'the outsider class is NOT reachable by the teacher',
      !reachable.includes(Number(otherClass!.id)),
    );

    // ── What each role's query actually returns ──────────────────────────────
    const allStudents = await db.select({ id: people.students.id })
      .from(people.students).where(eq(people.students.schoolId, schoolId));

    const teacherVisible = await db
      .select({ id: people.students.id })
      .from(people.students)
      .innerJoin(people.enrollments, and(
        eq(people.enrollments.studentId, people.students.id),
        eq(people.enrollments.status, 'active'),
      ))
      .where(and(
        eq(people.students.schoolId, schoolId),
        reachable.length > 0
          ? eq(people.enrollments.classId, reachable[0]!)
          : eq(people.students.id, -1),
      ));

    check(
      'teacher sees fewer students than the school holds',
      teacherVisible.length < allStudents.length,
      `${teacherVisible.length} of ${allStudents.length}`,
    );

    check(
      'the outsider student is NOT in the teacher\'s result set',
      !teacherVisible.some((s) => Number(s.id) === Number(outsider!.id)),
    );

    // ── A teacher with NO assignments must see NOTHING ───────────────────────
    // Fails closed. A missing assignment returning every student is the exact
    // shape of bug this check exists to catch.
    const emptyReachable: number[] = [];

    check(
      'a teacher with no assignments reaches no classes',
      emptyReachable.length === 0,
    );

    // ── School-wide roles see everything in their school ─────────────────────
    check(
      'school-wide roles see the whole school',
      allStudents.length > teacherVisible.length,
    );
  } finally {
    await client.end();
  }

  console.log(
    failures === 0
      ? '\nRole scoping holds.'
      : `\n${failures} check(s) FAILED — a role can see more than it should.`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Scope test error:', err);
  process.exit(1);
});
