import { and, eq, exists, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { caComponents, type CaScoreInput } from './validation';

export const CA_ROLES = ['teacher', 'principal', 'vice_principal', 'exam_officer'] as const;
export function canEnterCa(actor: Actor) { return (CA_ROLES as readonly string[]).includes(actor.role); }

/** The same subject/class assignment must match; separate assignments cannot be combined. */
export function caAssignment(tx: Tx, actor: Actor, classId: number | typeof schema.classes.id, subjectId: number | typeof schema.subjects.id) {
  if (!canEnterCa(actor)) return sql<boolean>`false`;
  if (actor.role !== 'teacher') return sql<boolean>`true`;
  if (!actor.staffId) return sql<boolean>`false`;
  return exists(tx.select({ one: sql`1` }).from(schema.staffAssignments)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
    .where(and(
      eq(schema.staffAssignments.schoolId, actor.schoolId),
      eq(schema.staffAssignments.staffId, actor.staffId),
      eq(schema.staffAssignments.classId, classId),
      eq(schema.staffAssignments.subjectId, subjectId),
      eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
      eq(schema.staffAssignments.status, 'active'),
      eq(schema.staff.schoolId, actor.schoolId),
      eq(schema.staff.userId, actor.userId),
      eq(schema.staff.status, 'active'),
    )));
}

export async function caSchool(tx: Tx, actor: Actor) {
  if (!canEnterCa(actor)) return null;
  const [school] = await tx.select({ settings: schema.schools.settings })
    .from(schema.schools).where(and(eq(schema.schools.id, actor.schoolId), eq(schema.schools.status, 'active')));
  return school ?? null;
}

/** Rechecked inside the score transaction, never trusted from hidden fields. */
export async function validateCaContext(tx: Tx, actor: Actor, args: CaScoreInput): Promise<string | null> {
  const school = await caSchool(tx, actor);
  if (!school) return 'You do not have permission to enter CA scores.';
  const component = caComponents(school.settings).find(c => c.key === args.componentKey);
  if (!component || component.maxScore !== args.maxScore) return 'The assessment configuration changed or is unavailable. Reload the score sheet.';
  const [context] = await tx.select({ id: schema.students.id }).from(schema.students)
    .innerJoin(schema.enrollments, and(
      eq(schema.enrollments.studentId, schema.students.id),
      eq(schema.enrollments.schoolId, actor.schoolId),
      eq(schema.enrollments.sessionId, args.sessionId), eq(schema.enrollments.status, 'active'),
    ))
    .innerJoin(schema.classes, and(eq(schema.classes.id, schema.enrollments.classId),
      eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')))
    .innerJoin(schema.studentSubjects, and(eq(schema.studentSubjects.studentId, schema.students.id),
      eq(schema.studentSubjects.schoolId, actor.schoolId), eq(schema.studentSubjects.sessionId, args.sessionId),
      eq(schema.studentSubjects.subjectId, args.subjectId)))
    .innerJoin(schema.subjects, and(eq(schema.subjects.id, schema.studentSubjects.subjectId),
      eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
    .innerJoin(schema.academicSessions, and(eq(schema.academicSessions.id, args.sessionId), eq(schema.academicSessions.schoolId, actor.schoolId)))
    .innerJoin(schema.terms, and(eq(schema.terms.id, args.termId),
      eq(schema.terms.sessionId, args.sessionId), eq(schema.terms.schoolId, actor.schoolId)))
    .where(and(eq(schema.students.id, args.studentId), eq(schema.students.schoolId, actor.schoolId),
      eq(schema.students.status, 'active'),
      args.classId ? eq(schema.classes.id, args.classId) : undefined,
      caAssignment(tx, actor, schema.classes.id, schema.subjects.id))).limit(1);
  return context ? null : 'This student or academic scope is unavailable for CA entry.';
}
