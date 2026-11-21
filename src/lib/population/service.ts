import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { manageableClassIds } from '@/lib/people/arm-assignment';

type Tx = Parameters<Parameters<typeof forSchool>[1]>[0];

/** The classes this person is class teacher of, whatever their role. */
async function heldClassIds(tx: Tx, actor: Actor): Promise<number[]> {
  const rows = await tx.select({ classId: schema.staffAssignments.classId }).from(schema.staffAssignments).where(and(
    eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId!),
    eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active')));
  return [...new Set(rows.map((r) => Number(r.classId)))];
}
import { currentSessionId } from '@/lib/people/students';
import { fold, type ClassPopulation } from './rules';

/**
 * Enrolled students by class and gender for the CURRENT session.
 *
 * Who sees what is decided here, in the query: the principal, vice principal and exam office see every class; a class
 * teacher sees only the classes they hold (so another class's numbers never leave the database); a subject teacher, a
 * student and a parent see nothing. The page showing or hiding the card is only presentation.
 *
 * Counts an active enrolment of an ACTIVE student. Suspended, withdrawn, expelled and pending students are not counted,
 * and neither are old-session enrolments, because the question is "how many do we have in each class right now".
 */
export async function populationByClass(actor: Actor, opts: { mine?: boolean } = {}): Promise<ClassPopulation[]> {
  return forSchool(actor.schoolId, async (tx) => {
    // "Mine" is the Teaching view of someone who is ALSO school-wide: only the classes they personally hold.
    const only = opts.mine && actor.staffId ? await heldClassIds(tx, actor) : await manageableClassIds(tx, actor);
    if (only !== null && only.length === 0) return [];
    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) return [];

    const rows = await tx.select({
      classId: schema.classes.id, className: schema.classes.displayName, gender: schema.students.gender,
      n: sql<number>`count(*)`.mapWith(Number),
    })
      .from(schema.enrollments)
      .innerJoin(schema.students, and(eq(schema.students.id, schema.enrollments.studentId), eq(schema.students.schoolId, schema.enrollments.schoolId), eq(schema.students.status, 'active')))
      .innerJoin(schema.classes, and(eq(schema.classes.id, schema.enrollments.classId), eq(schema.classes.schoolId, schema.enrollments.schoolId)))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.classes.levelId))
      .where(and(
        eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active'),
        only === null ? undefined : inArray(schema.enrollments.classId, only),
      ))
      .groupBy(schema.classes.id, schema.classes.displayName, schema.students.gender, schema.classLevels.levelOrder, schema.classes.arm)
      .orderBy(asc(schema.classLevels.levelOrder), asc(schema.classes.arm), asc(schema.classes.id));

    return fold(rows.map((r) => ({ classId: Number(r.classId), className: r.className, gender: r.gender, n: r.n })));
  });
}
