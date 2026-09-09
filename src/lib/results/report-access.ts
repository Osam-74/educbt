import { and, eq } from 'drizzle-orm';
import { schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';

/** Legacy report scope: school-wide staff, assigned class teacher, self or linked child. */
export async function reportAudience(tx: Tx, actor: Actor, studentId: number, sessionId: number): Promise<'staff' | 'teacher' | 'family' | null> {
  const [user] = await tx.select({ id: schema.users.id }).from(schema.users)
    .innerJoin(schema.schools, eq(schema.schools.id, schema.users.schoolId)).where(and(
      eq(schema.users.id, actor.userId), eq(schema.users.role, actor.role as 'principal'),
      eq(schema.users.status, 'active'), eq(schema.schools.status, 'active')));
  if (!user) return null;
  if (['principal', 'vice_principal', 'exam_officer'].includes(actor.role)) return 'staff';
  if (actor.role === 'student') {
    const [own] = await tx.select({ id: schema.students.id }).from(schema.students)
      .where(and(eq(schema.students.id, studentId), eq(schema.students.userId, actor.userId), eq(schema.students.status, 'active')));
    return own ? 'family' : null;
  }
  if (actor.role === 'parent') {
    const [child] = await tx.select({ id: schema.guardianStudent.id }).from(schema.guardianStudent)
      .innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId))
      .where(and(eq(schema.guardians.userId, actor.userId), eq(schema.guardianStudent.studentId, studentId)));
    return child ? 'family' : null;
  }
  if (actor.role === 'teacher' && actor.staffId) {
    const [assigned] = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments)
      .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
      .innerJoin(schema.enrollments, eq(schema.enrollments.classId, schema.staffAssignments.classId)).where(and(
        eq(schema.staff.userId, actor.userId), eq(schema.staff.id, actor.staffId), eq(schema.staff.status, 'active'),
        eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active'),
        eq(schema.enrollments.studentId, studentId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
    return assigned ? 'teacher' : null;
  }
  return null;
}
