/**
 * Class management — ported from the legacy plugin's school/classes.php and
 * its handlers: create_classes / update_class / remove_class in
 * PortalActions, create_arms in AcademicStructureService.
 *
 * A class is one ARM of a level ("SS 1 Science A"); the level and department
 * carry the academic meaning (see schema/core.ts). MANAGE_CLASSES sits with
 * the principal and vice principal (capabilities.php) — every entry point
 * re-checks it at the service boundary.
 */
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { schema, forSchool } from '@/db';
import type { Actor } from '@/lib/session';

export class ClassError extends Error {
  public readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ClassError';
    this.field = field;
  }
}

/** Legacy MANAGE_CLASSES: principal and vice principal. */
const MANAGE_CLASSES_ROLES = ['principal', 'vice_principal'];

function assertManageClasses(actor: Actor): void {
  if (!MANAGE_CLASSES_ROLES.includes(actor.role)) {
    throw new ClassError('You do not have permission to manage classes.');
  }
}

// 'both' is the shared stage enum's value; levels in practice are junior or senior.
export type ClassLevelOption = { id: number; name: string; stage: 'junior' | 'senior' | 'both' };
export type DepartmentOption = { id: number; name: string };

export type ClassRow = {
  id: number;
  displayName: string;
  arm: string | null;
  capacity: number;
  departmentId: number | null;
  departmentName: string | null;
  classTeacher: string | null;
  /** Active enrolments in the current session — the number classes.php shows. */
  students: number;
};

export async function classesView(actor: Actor): Promise<{
  levels: ClassLevelOption[];
  departments: DepartmentOption[];
  rows: ClassRow[];
}> {
  assertManageClasses(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const levels = await tx.select({
      id: schema.classLevels.id,
      name: schema.classLevels.name,
      stage: schema.classLevels.stage,
    })
      .from(schema.classLevels)
      .where(eq(schema.classLevels.schoolId, actor.schoolId))
      .orderBy(asc(schema.classLevels.levelOrder));

    const departments = await tx.select({
      id: schema.departments.id,
      name: schema.departments.name,
    })
      .from(schema.departments)
      .where(eq(schema.departments.schoolId, actor.schoolId))
      .orderBy(asc(schema.departments.sortOrder));

    const [session] = await tx.select({ id: schema.academicSessions.id })
      .from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.schoolId, actor.schoolId), eq(schema.academicSessions.isCurrent, true)))
      .limit(1);

    const rows = await tx.select({
      id: schema.classes.id,
      displayName: schema.classes.displayName,
      arm: schema.classes.arm,
      capacity: schema.classes.capacity,
      departmentId: schema.classes.departmentId,
      departmentName: schema.departments.name,
      classTeacher: sql<string | null>`(
        SELECT trim(s.first_name || ' ' || s.last_name)
        FROM ${schema.staffAssignments} a
        INNER JOIN ${schema.staff} s ON s.id = a.staff_id
        WHERE a.class_id = ${schema.classes.id}
          AND a.assignment_type = 'class_teacher'
          AND a.status = 'active'
        LIMIT 1
      )`,
      students: sql<number>`(
        SELECT count(*) FROM ${schema.enrollments} e
        WHERE e.class_id = ${schema.classes.id}
          AND e.status = 'active'
          ${session ? sql`AND e.session_id = ${session.id}` : sql``}
      )`.mapWith(Number),
    })
      .from(schema.classes)
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.classes.levelId))
      .leftJoin(schema.departments, eq(schema.departments.id, schema.classes.departmentId))
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')))
      .orderBy(asc(schema.classLevels.levelOrder), asc(schema.classes.arm), asc(schema.classes.displayName));

    return { levels, departments, rows };
  });
}

// ── Create ──────────────────────────────────────────────────────────────────

export type CreateClassesResult = { created: string[]; skipped: string[] };

export async function createClasses(
  actor: Actor,
  input: { levelId: number; arms: string; departmentId?: number },
): Promise<CreateClassesResult> {
  assertManageClasses(actor);

  // Accept "A,B,C" or "A B C" — nobody should have to guess the separator
  // (create_classes). Uppercased: an arm is a code, not a sentence.
  const arms = input.arms
    .split(/[\s,]+/)
    .map((a) => a.trim().toUpperCase())
    .filter(Boolean);
  const list = arms.length ? arms : ['']; // empty arms box = one unlettered class

  return forSchool(actor.schoolId, async (tx) => {
    const [level] = await tx.select().from(schema.classLevels)
      .where(and(eq(schema.classLevels.id, input.levelId), eq(schema.classLevels.schoolId, actor.schoolId)))
      .limit(1);
    if (!level) throw new ClassError('Choose a level — that one could not be found.', 'levelId');

    // Departments are a senior-school concept. A junior class carrying one
    // would silently break subject offering lookups (create_class).
    if (input.departmentId && level.stage !== 'senior') {
      throw new ClassError('Departments are a senior-school concept. That level cannot carry one.', 'departmentId');
    }

    let departmentName: string | null = null;
    if (input.departmentId) {
      const [department] = await tx.select({ name: schema.departments.name }).from(schema.departments)
        .where(and(eq(schema.departments.id, input.departmentId), eq(schema.departments.schoolId, actor.schoolId)))
        .limit(1);
      if (!department) throw new ClassError('That department could not be found.', 'departmentId');
      departmentName = department.name;
    }

    const created: string[] = [];
    const skipped: string[] = [];

    for (const arm of list) {
      if (arm && !/^[A-Z]{1,3}$/.test(arm)) {
        skipped.push(`"${arm}" is not a valid arm — use 1 to 3 letters.`);
        continue;
      }

      const displayName = [level.name, arm, departmentName].filter(Boolean).join(' ');

      // The UNIQUE key on (school, level, department, arm) does NOT catch
      // duplicates when department_id is NULL — NULL never equals NULL — so
      // the check is explicit (create_class). It looks at EVERY row for this
      // key, not just active ones: a removed class is only soft-deleted, so
      // the row survives and the key still rejects a fresh insert. Revive it
      // instead of failing on a class the user cannot see anywhere.
      const [existing] = await tx.select({ id: schema.classes.id, status: schema.classes.status })
        .from(schema.classes)
        .where(and(
          eq(schema.classes.schoolId, actor.schoolId),
          eq(schema.classes.levelId, level.id),
          eq(schema.classes.arm, arm),
          sql`COALESCE(${schema.classes.departmentId}, 0) = ${input.departmentId ?? 0}`,
        ))
        .limit(1);

      if (existing) {
        if (existing.status === 'active') {
          skipped.push(`${displayName} already exists.`);
          continue;
        }
        await tx.update(schema.classes)
          .set({ status: 'active', displayName })
          .where(eq(schema.classes.id, existing.id));
        created.push(displayName);
        continue;
      }

      await tx.insert(schema.classes).values({
        schoolId: actor.schoolId,
        levelId: level.id,
        departmentId: input.departmentId ?? null,
        arm,
        displayName,
        capacity: 0,
        status: 'active',
      });
      created.push(displayName);
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'classes.created',
      entityType: 'classes',
      entityId: level.id,
      after: { level: level.name, created, skipped },
    });

    return { created, skipped };
  });
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updateClass(
  actor: Actor,
  input: { classId: number; arm: string; capacity: number; departmentId?: number },
): Promise<{ displayName: string }> {
  assertManageClasses(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select().from(schema.classes)
      .where(and(eq(schema.classes.id, input.classId), eq(schema.classes.schoolId, actor.schoolId)))
      .limit(1);
    if (!row) throw new ClassError('That class could not be found.');

    const arm = input.arm.trim().toUpperCase();
    if (arm && !/^[A-Z]{1,3}$/.test(arm)) {
      throw new ClassError(`"${arm}" is not a valid arm — use 1 to 3 letters.`, 'arm');
    }

    const [level] = await tx.select().from(schema.classLevels)
      .where(eq(schema.classLevels.id, row.levelId)).limit(1);
    if (!level) throw new ClassError('That class could not be found.');

    if (input.departmentId && level.stage !== 'senior') {
      throw new ClassError('Departments are a senior-school concept. That level cannot carry one.', 'departmentId');
    }

    let departmentName: string | null = null;
    if (input.departmentId) {
      const [department] = await tx.select({ name: schema.departments.name }).from(schema.departments)
        .where(and(eq(schema.departments.id, input.departmentId), eq(schema.departments.schoolId, actor.schoolId)))
        .limit(1);
      if (!department) throw new ClassError('That department could not be found.', 'departmentId');
      departmentName = department.name;
    }

    const displayName = [level.name, arm, departmentName].filter(Boolean).join(' ');

    // Same NULL-safe duplicate check as create, excluding the row itself.
    const [dupe] = await tx.select({ id: schema.classes.id }).from(schema.classes)
      .where(and(
        eq(schema.classes.schoolId, actor.schoolId),
        eq(schema.classes.levelId, level.id),
        eq(schema.classes.arm, arm),
        sql`COALESCE(${schema.classes.departmentId}, 0) = ${input.departmentId ?? 0}`,
        ne(schema.classes.id, input.classId),
      ))
      .limit(1);
    if (dupe) throw new ClassError(`${displayName} already exists.`);

    await tx.update(schema.classes)
      .set({
        arm,
        displayName,
        capacity: Math.max(0, Math.floor(input.capacity) || 0),
        departmentId: input.departmentId ?? null,
      })
      .where(and(eq(schema.classes.id, input.classId), eq(schema.classes.schoolId, actor.schoolId)));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'class.updated',
      entityType: 'classes',
      entityId: input.classId,
      before: { displayName: row.displayName },
      after: { displayName, arm, capacity: Math.max(0, Math.floor(input.capacity) || 0), departmentId: input.departmentId ?? null },
    });

    return { displayName };
  });
}

// ── Remove (archive — the row survives for the records its results point at) ─

export async function removeClass(actor: Actor, classId: number): Promise<{ name: string }> {
  assertManageClasses(actor);

  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select().from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId)))
      .limit(1);
    if (!row) throw new ClassError('That class could not be found.');

    // Removing a class with students would leave them enrolled in nothing
    // (remove_class). Counted across every session, not just the current one.
    const [enrolled] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.enrollments)
      .where(and(eq(schema.enrollments.classId, classId), eq(schema.enrollments.status, 'active')));
    if (enrolled && enrolled.count > 0) {
      throw new ClassError(
        `${enrolled.count} student${enrolled.count === 1 ? '' : 's'} still in ${row.displayName}. ` +
        'Move them to another class first — removing it would leave them enrolled in nothing.',
      );
    }

    const [papers] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.examPapers)
      .where(and(eq(schema.examPapers.classId, classId), ne(schema.examPapers.status, 'cancelled')));
    if (papers && papers.count > 0) {
      throw new ClassError(`${papers.count} paper${papers.count === 1 ? '' : 's'} set for ${row.displayName}. Cancel them first.`);
    }

    await tx.update(schema.classes)
      .set({ status: 'archived' })
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId)));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'class.removed',
      entityType: 'classes',
      entityId: classId,
      before: { displayName: row.displayName },
    });

    return { name: row.displayName };
  });
}
