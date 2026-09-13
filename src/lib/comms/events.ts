/**
 * Domain event emitters (legacy NotificationService hooks parity).
 *
 * Notifications are a consequence of what happened, not something every
 * service has to remember to call — but the legacy plugin's global
 * action-subscription system is a WordPress pattern, not a platform one.
 * Here each emitter is a function the owning service calls INSIDE its own
 * transaction, so a notification can never appear without the work that
 * caused it committing too (and can never appear for rolled-back work).
 *
 * Results-published is the flagship: every affected student AND every
 * guardian permitted to see results (can_view_results per link, not per
 * guardian) is told — only guardians who may see results are told they
 * exist.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Tx } from '@/db';
import { notifyMany, type NotificationType } from './notifications';

export async function notifyResultsPublished(
  tx: Tx,
  schoolId: number,
  classId: number,
): Promise<{ students: number; guardians: number }> {
  const studentRows = await tx
    .selectDistinct({ userId: schema.students.userId })
    .from(schema.enrollments)
    .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
    .where(and(
      eq(schema.enrollments.schoolId, schoolId),
      eq(schema.enrollments.classId, classId),
      eq(schema.enrollments.status, 'active'),
      eq(schema.students.status, 'active'),
    ));
  const studentUsers = studentRows.map((r) => r.userId).filter((id): id is number => id != null);

  const guardianRows = await tx
    .selectDistinct({ userId: schema.guardians.userId })
    .from(schema.enrollments)
    .innerJoin(schema.guardianStudent, and(
      eq(schema.guardianStudent.studentId, schema.enrollments.studentId),
      eq(schema.guardianStudent.canViewResults, true),
    ))
    .innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId))
    .where(and(
      eq(schema.enrollments.schoolId, schoolId),
      eq(schema.enrollments.classId, classId),
      eq(schema.enrollments.status, 'active'),
    ));
  const guardianUsers = guardianRows.map((r) => r.userId).filter((id): id is number => id != null);

  const a = await notifyMany(tx, schoolId, studentUsers.map((userId) => ({
    userId,
    type: 'result_published' as const,
    title: 'Your result is available',
    body: 'Your result for this term has been published. You can now view it from your portal.',
    link: '/portal/my-results',
  })));

  const b = await notifyMany(tx, schoolId, guardianUsers.map((userId) => ({
    userId,
    type: 'result_published' as const,
    title: 'Your child’s result is available',
    body: 'The result for this term has been published and can be viewed in the parent portal.',
    link: '/portal/children',
  })));

  return { students: a, guardians: b };
}

/** Guardian invite: the office just linked a guardian; their portal access
 *  begins here. The invite token itself never appears in a notification. */
export async function notifyGuardianInvited(tx: Tx, schoolId: number, guardianUserId: number | null): Promise<void> {
  if (guardianUserId == null || guardianUserId <= 0) return;
  await notifyMany(tx, schoolId, [{
    userId: guardianUserId,
    type: 'guardian_invite' as const,
    title: 'Welcome to the parent portal',
    body: 'Your account is ready. You can see your children’s results and school announcements here.',
    link: '/portal/children',
  }]);
}

/** A password was (re)set for this user. The notification never carries the
 *  password or a token — it says the office did it, so an unexpected one is
 *  a reportable event for the account holder. */
export async function notifyPasswordChanged(tx: Tx, schoolId: number, userId: number): Promise<void> {
  if (userId <= 0) return;
  await notifyMany(tx, schoolId, [{
    userId,
    type: 'password_reset' as const,
    title: 'Your password was changed',
    body: 'Your portal password was set or reset. If this was not you, contact the school office immediately.',
    link: '/portal/account/password',
  }]);
}

/** Promotion committed: every student whose outcome was recorded is told
 *  their placement for the new session (the outcome itself came from the
 *  decisions the principal reviewed). */
export async function notifyPromotionApproved(
  tx: Tx,
  schoolId: number,
  studentIds: number[],
): Promise<number> {
  if (studentIds.length === 0) return 0;
  const rows = await tx
    .selectDistinct({ userId: schema.students.userId })
    .from(schema.students)
    .where(and(
      eq(schema.students.schoolId, schoolId),
      inArray(schema.students.id, studentIds),
    ));
  const users = rows.map((r) => r.userId).filter((id): id is number => id != null);
  return notifyMany(tx, schoolId, users.map((userId) => ({
    userId,
    type: 'promotion_approved' as const,
    title: 'Your promotion has been approved',
    body: 'Your placement for the new session has been finalized. Contact the office with any questions.',
    link: '/portal',
  })));
}
