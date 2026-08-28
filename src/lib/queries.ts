/**
 * Read queries for the portal.
 *
 * AUTHORISATION DECIDES WHAT IS FETCHED, NOT WHAT IS RENDERED.
 *
 * Every function here narrows by role before it touches a table. A teacher's
 * query is built against their own assignments, so the rows for other classes
 * are never selected — not selected and then hidden. Hiding rows client-side
 * leaves them in the payload, where anybody can read them with dev tools open.
 *
 * RLS underneath means a mistake in this file produces an empty screen rather
 * than another school's data. The two layers are deliberate: RLS guards the
 * tenant boundary, this file guards the boundary within a tenant.
 */

import { and, eq, ilike, or, sql, inArray, asc, count } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';

const SCHOOL_WIDE = ['principal', 'vice_principal', 'exam_officer'];

export function isSchoolWide(role: string): boolean {
  return SCHOOL_WIDE.includes(role);
}

/**
 * The classes a teacher may see.
 *
 * Empty for a teacher with no assignments — which correctly yields no students
 * rather than all of them. A missing assignment must never fail open.
 */
async function reachableClassIds(actor: Actor): Promise<number[] | 'all'> {
  if (isSchoolWide(actor.role)) return 'all';

  if (!actor.staffId) return [];

  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({ classId: schema.staffAssignments.classId })
      .from(schema.staffAssignments)
      .where(and(
        eq(schema.staffAssignments.staffId, actor.staffId!),
        eq(schema.staffAssignments.status, 'active'),
      ));

    return rows
      .map((r) => r.classId)
      .filter((id): id is number => id !== null);
  });
}

export type StudentRow = {
  id: number;
  admissionNumber: string;
  firstName: string;
  lastName: string;
  gender: string | null;
  status: string;
  className: string | null;
};

export async function listStudents(
  actor: Actor,
  opts: { search?: string; status?: string; classId?: number } = {},
): Promise<{ rows: StudentRow[]; scopeNote: string | null }> {
  const reachable = await reachableClassIds(actor);

  if (reachable !== 'all' && reachable.length === 0) {
    return {
      rows: [],
      scopeNote: 'You have no class assignments, so no students are listed.',
    };
  }

  const rows = await forSchool(actor.schoolId, async (tx) => {
    const conditions = [eq(schema.students.schoolId, actor.schoolId)];

    // Status filters on the STUDENT's standing, which is what the list displays.
    // The old system filtered on enrolment status while showing student status,
    // so totals never reconciled with the rows beneath them.
    if (opts.status && opts.status !== 'all') {
      conditions.push(eq(schema.students.status, opts.status as 'active'));
    }

    if (opts.search) {
      const term = `%${opts.search}%`;
      conditions.push(
        or(
          ilike(schema.students.firstName, term),
          ilike(schema.students.lastName, term),
          ilike(schema.students.admissionNumber, term),
          sql`${schema.students.firstName} || ' ' || ${schema.students.lastName} ILIKE ${term}`,
        )!,
      );
    }

    if (opts.classId) conditions.push(eq(schema.enrollments.classId, opts.classId));

    if (reachable !== 'all') {
      conditions.push(inArray(schema.enrollments.classId, reachable));
    }

    return tx
      .select({
        id: schema.students.id,
        admissionNumber: schema.students.admissionNumber,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        gender: schema.students.gender,
        status: schema.students.status,
        className: schema.classes.displayName,
      })
      .from(schema.students)
      .leftJoin(schema.enrollments, and(
        eq(schema.enrollments.studentId, schema.students.id),
        eq(schema.enrollments.status, 'active'),
      ))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
      .where(and(...conditions))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName))
      .limit(500);
  });

  return {
    rows,
    scopeNote: reachable === 'all' ? null : 'Showing students in your assigned classes only.',
  };
}

export async function getStudent(actor: Actor, studentId: number) {
  const reachable = await reachableClassIds(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [student] = await tx
      .select()
      .from(schema.students)
      .where(and(
        eq(schema.students.id, studentId),
        eq(schema.students.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!student) return null;

    const [enrolment] = await tx
      .select({
        classId: schema.classes.id,
        className: schema.classes.displayName,
        sessionTitle: schema.academicSessions.title,
      })
      .from(schema.enrollments)
      .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
      .leftJoin(schema.academicSessions, eq(schema.academicSessions.id, schema.enrollments.sessionId))
      .where(and(
        eq(schema.enrollments.studentId, studentId),
        eq(schema.enrollments.status, 'active'),
      ))
      .limit(1);

    // A teacher may open only a student in a class they teach. Checked here,
    // after the lookup, because the answer depends on the enrolment.
    if (reachable !== 'all') {
      const allowed = enrolment?.classId != null && reachable.includes(enrolment.classId);
      if (!allowed) return null;
    }

    const subjects = await tx
      .select({
        id: schema.subjects.id,
        name: schema.subjects.name,
        code: schema.subjects.code,
      })
      .from(schema.studentSubjects)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.studentSubjects.subjectId))
      .where(eq(schema.studentSubjects.studentId, studentId))
      .orderBy(asc(schema.subjects.name));

    return { student, enrolment: enrolment ?? null, subjects };
  });
}

export async function listStaff(actor: Actor) {
  if (!isSchoolWide(actor.role)) return [];

  return forSchool(actor.schoolId, async (tx) =>
    tx
      .select({
        id: schema.staff.id,
        staffNumber: schema.staff.staffNumber,
        firstName: schema.staff.firstName,
        lastName: schema.staff.lastName,
        role: schema.staff.role,
        email: schema.staff.email,
        status: schema.staff.status,
      })
      .from(schema.staff)
      .where(eq(schema.staff.schoolId, actor.schoolId))
      .orderBy(asc(schema.staff.lastName))
      .limit(500),
  );
}

export async function listClasses(actor: Actor) {
  const reachable = await reachableClassIds(actor);

  if (reachable !== 'all' && reachable.length === 0) return [];

  return forSchool(actor.schoolId, async (tx) => {
    const conditions = [
      eq(schema.classes.schoolId, actor.schoolId),
      eq(schema.classes.status, 'active'),
    ];

    if (reachable !== 'all') conditions.push(inArray(schema.classes.id, reachable));

    return tx
      .select({
        id: schema.classes.id,
        displayName: schema.classes.displayName,
        levelName: schema.classLevels.name,
        levelOrder: schema.classLevels.levelOrder,
        departmentName: schema.departments.name,
        headcount: sql<number>`(
          SELECT count(*) FROM ${schema.enrollments} e
          WHERE e.class_id = ${schema.classes.id} AND e.status = 'active'
        )`.mapWith(Number),
      })
      .from(schema.classes)
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.classes.levelId))
      .leftJoin(schema.departments, eq(schema.departments.id, schema.classes.departmentId))
      .where(and(...conditions))
      .orderBy(asc(schema.classLevels.levelOrder), asc(schema.classes.displayName));
  });
}

export async function listSubjects(actor: Actor) {
  return forSchool(actor.schoolId, async (tx) =>
    tx
      .select({
        id: schema.subjects.id,
        name: schema.subjects.name,
        code: schema.subjects.code,
        stage: schema.subjects.stage,
        category: schema.subjects.category,
        isCompulsory: schema.subjects.isCompulsory,
        departmentName: schema.departments.name,
        status: schema.subjects.status,
      })
      .from(schema.subjects)
      .leftJoin(schema.departments, eq(schema.departments.id, schema.subjects.departmentId))
      .where(eq(schema.subjects.schoolId, actor.schoolId))
      .orderBy(asc(schema.subjects.stage), asc(schema.subjects.name)),
  );
}

export async function schoolStats(actor: Actor) {
  if (!isSchoolWide(actor.role)) return null;

  return forSchool(actor.schoolId, async (tx) => {
    const [students] = await tx.select({ n: count() }).from(schema.students)
      .where(and(
        eq(schema.students.schoolId, actor.schoolId),
        eq(schema.students.status, 'active'),
      ));

    const [staff] = await tx.select({ n: count() }).from(schema.staff)
      .where(and(
        eq(schema.staff.schoolId, actor.schoolId),
        eq(schema.staff.status, 'active'),
      ));

    const [classes] = await tx.select({ n: count() }).from(schema.classes)
      .where(eq(schema.classes.schoolId, actor.schoolId));

    const [subjects] = await tx.select({ n: count() }).from(schema.subjects)
      .where(eq(schema.subjects.schoolId, actor.schoolId));

    return {
      students: students?.n ?? 0,
      staff: staff?.n ?? 0,
      classes: classes?.n ?? 0,
      subjects: subjects?.n ?? 0,
    };
  });
}
