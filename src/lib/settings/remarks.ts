import { and, eq, inArray } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { lockResultTerm } from '@/lib/ca/lock';
import { audit, fail, ownStaff, settingsAccess } from './service';
import { suggestedRemark } from './validation';

/** Never fall back to a random teacher or choose among multiple principals. */
export async function reportStaff(tx: Tx, classId: number) {
  const principals = await tx.select({ id: schema.staff.id }).from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId)).where(and(eq(schema.staff.role, 'principal'),
      eq(schema.staff.status, 'active'), eq(schema.users.status, 'active'), eq(schema.users.role, 'principal')));
  const teachers = await tx.select({ id: schema.staff.id }).from(schema.staffAssignments)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId)).where(and(eq(schema.staffAssignments.classId, classId),
      eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active'),
      eq(schema.staff.status, 'active'), eq(schema.users.status, 'active')));
  const ids = [...new Set(teachers.map(t => t.id))];
  return { principal: principals.length === 1 ? principals[0]!.id : null, class_teacher: ids.length === 1 ? ids[0]! : null };
}
export async function reportExtras(tx: Tx, studentId: number, sessionId: number, termId: number, classId: number) {
  const staff = await reportStaff(tx, classId);
  const signatures = await tx.select().from(schema.staffSignatures);
  const remarks = await tx.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.studentId, studentId),
    eq(schema.reportRemarks.sessionId, sessionId), eq(schema.reportRemarks.termId, termId)));
  return { signatures: { principal: signatures.find(s => s.role === 'principal' && s.staffId === staff.principal) ?? null,
    class_teacher: signatures.find(s => s.role === 'class_teacher' && s.staffId === staff.class_teacher) ?? null },
    remarks: { principal: remarks.find(r => r.role === 'principal')?.remark ?? null, class_teacher: remarks.find(r => r.role === 'class_teacher')?.remark ?? null } };
}
/** Snapshot suggestions at compilation. Published sheets never consult live ranges.
 * Manual overrides survive recompilation. Incomplete students get no suggestion.
 */
export async function snapshotRemarks(tx: Tx, actor: Actor, scope: { classId: number; sessionId: number; termId: number }, studentIds: number[]) {
  if (!studentIds.length) return;
  const staff = await reportStaff(tx, scope.classId);
  const ranges = await tx.select().from(schema.staffRemarkRanges);
  const rows = await tx.select().from(schema.subjectResults).where(and(inArray(schema.subjectResults.studentId, studentIds),
    eq(schema.subjectResults.sessionId, scope.sessionId), eq(schema.subjectResults.termId, scope.termId)));
  const registrations = await tx.select().from(schema.studentSubjects).where(and(inArray(schema.studentSubjects.studentId, studentIds), eq(schema.studentSubjects.sessionId, scope.sessionId)));
  for (const studentId of studentIds) {
    const own = rows.filter(r => r.studentId === studentId);
    const complete = own.length > 0 && own.every(r => r.complete) && registrations.filter(r => r.studentId === studentId).every(r => own.some(o => o.subjectId === r.subjectId));
    const average = complete ? own.reduce((sum, r) => sum + Number(r.total), 0) / own.length : null;
    for (const role of ['principal', 'class_teacher'] as const) {
      const [before] = await tx.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.studentId, studentId),
        eq(schema.reportRemarks.sessionId, scope.sessionId), eq(schema.reportRemarks.termId, scope.termId), eq(schema.reportRemarks.role, role)));
      if (before?.source === 'manual') continue;
      const config = ranges.find(r => r.role === role && r.staffId === staff[role]);
      const remark = average === null || !config ? null : suggestedRemark(config.ranges, average);
      if (!remark || !staff[role]) {
        if (before) { await tx.delete(schema.reportRemarks).where(eq(schema.reportRemarks.id, before.id)); await audit(tx, actor, 'automatic_remark', before, null); }
        continue;
      }
      const after = { schoolId: actor.schoolId, studentId, sessionId: scope.sessionId, termId: scope.termId,
        staffId: staff[role]!, role, source: 'automatic', remark, updatedAt: new Date() };
      await tx.insert(schema.reportRemarks).values(after).onConflictDoUpdate({ target: [schema.reportRemarks.schoolId, schema.reportRemarks.studentId,
        schema.reportRemarks.sessionId, schema.reportRemarks.termId, schema.reportRemarks.role], set: after });
      await audit(tx, actor, 'automatic_remark', before ?? null, after);
    }
  }
}
export async function saveManualRemark(actor: Actor, input: { studentId: number; sessionId: number; termId: number; role: string; remark: string }) {
  if (![input.studentId, input.sessionId, input.termId].every(n => Number.isSafeInteger(n) && n > 0) ||
    !['principal', 'class_teacher'].includes(input.role) || typeof input.remark !== 'string' || input.remark.length > 500) fail('Choose a student, term and remark of at most 500 characters.');
  return forSchool(actor.schoolId, async tx => {
    await lockResultTerm(tx, actor.schoolId, input.sessionId, input.termId);
    await settingsAccess(tx, actor);
    const staff = await ownStaff(tx, actor, input.role);
    const [term] = await tx.select().from(schema.terms).where(and(eq(schema.terms.id, input.termId), eq(schema.terms.sessionId, input.sessionId)));
    const [enrolment] = await tx.select().from(schema.enrollments).where(and(eq(schema.enrollments.studentId, input.studentId),
      eq(schema.enrollments.sessionId, input.sessionId), eq(schema.enrollments.status, 'active')));
    if (!term || !enrolment) fail('Student or term unavailable.');
    if (input.role === 'class_teacher') {
      const [assignment] = await tx.select().from(schema.staffAssignments).where(and(eq(schema.staffAssignments.staffId, staff.id),
        eq(schema.staffAssignments.classId, enrolment!.classId), eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active')));
      if (!assignment) fail('You may only remark on students in your assigned class.');
    }
    const rows = await tx.select().from(schema.subjectResults).where(and(eq(schema.subjectResults.studentId, input.studentId),
      eq(schema.subjectResults.sessionId, input.sessionId), eq(schema.subjectResults.termId, input.termId)));
    if (!rows.length || rows.some(r => !['draft', 'compiled'].includes(r.state) || r.published)) fail('Remarks may only change before review. Reopen results through the lifecycle first.');
    const [before] = await tx.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.studentId, input.studentId),
      eq(schema.reportRemarks.sessionId, input.sessionId), eq(schema.reportRemarks.termId, input.termId), eq(schema.reportRemarks.role, input.role)));
    const after = { ...input, remark: input.remark.trim(), source: 'manual', schoolId: actor.schoolId, staffId: staff.id, updatedAt: new Date() };
    await tx.insert(schema.reportRemarks).values(after).onConflictDoUpdate({ target: [schema.reportRemarks.schoolId, schema.reportRemarks.studentId,
      schema.reportRemarks.sessionId, schema.reportRemarks.termId, schema.reportRemarks.role], set: after });
    await audit(tx, actor, 'manual_remark', before ?? null, after);
  });
}
