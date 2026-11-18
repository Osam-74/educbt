import { and, eq, inArray } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { lockResultTerm } from '@/lib/ca/lock';
import { audit, fail, ownStaff, settingsAccess } from './service';
import { suggestedRemark } from './validation';

/** Never fall back to a random teacher or choose among multiple principals.
 *  School-scoped: on a multi-tenant platform every school has its own principal,
 *  so resolving without the school filter would find several and refuse —
 *  which would silently strip remarks and signatures from every report. */
export async function reportStaff(tx: Tx, schoolId: number, classId: number) {
  const principals = await tx.select({ id: schema.staff.id }).from(schema.staff)
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId)).where(and(eq(schema.staff.schoolId, schoolId),
      eq(schema.staff.role, 'principal'),
      eq(schema.staff.status, 'active'), eq(schema.users.status, 'active'), eq(schema.users.role, 'principal')));
  const teachers = await tx.select({ id: schema.staff.id }).from(schema.staffAssignments)
    .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
    .innerJoin(schema.users, eq(schema.users.id, schema.staff.userId)).where(and(eq(schema.staffAssignments.classId, classId),
      eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active'),
      eq(schema.staff.status, 'active'), eq(schema.users.status, 'active')));
  const ids = [...new Set(teachers.map(t => t.id))];
  return { principal: principals.length === 1 ? principals[0]!.id : null, class_teacher: ids.length === 1 ? ids[0]! : null };
}
export async function reportExtras(tx: Tx, schoolId: number, studentId: number, sessionId: number, termId: number, classId: number) {
  const staff = await reportStaff(tx, schoolId, classId);
  const signatures = await tx.select().from(schema.staffSignatures).where(eq(schema.staffSignatures.schoolId, schoolId));
  const remarks = await tx.select().from(schema.reportRemarks).where(and(eq(schema.reportRemarks.studentId, studentId),
    eq(schema.reportRemarks.sessionId, sessionId), eq(schema.reportRemarks.termId, termId)));
  // A school moved over from the WordPress plugin keeps its old remarks in term_summaries. They show only where no
  // report_remarks row exists, so a remark written or generated here always wins over an imported one.
  const [imported] = await tx.select().from(schema.termSummaries).where(and(eq(schema.termSummaries.schoolId, schoolId),
    eq(schema.termSummaries.studentId, studentId), eq(schema.termSummaries.termId, termId)));
  const importedText = (v: string | undefined) => (v && v.trim() ? v : null);
  return { signatures: { principal: signatures.find(s => s.role === 'principal' && s.staffId === staff.principal) ?? null,
    class_teacher: signatures.find(s => s.role === 'class_teacher' && s.staffId === staff.class_teacher) ?? null },
    remarks: { principal: remarks.find(r => r.role === 'principal')?.remark ?? importedText(imported?.principalRemark),
      class_teacher: remarks.find(r => r.role === 'class_teacher')?.remark ?? importedText(imported?.classTeacherRemark) },
    attendance: imported && imported.daysTotal > 0 ? { present: imported.daysPresent, total: imported.daysTotal } : null };
}
/** Snapshot suggestions at compilation. Published sheets never consult live ranges.
 * Manual overrides survive recompilation. Incomplete students get no suggestion.
 */
export async function snapshotRemarks(tx: Tx, actor: Actor, scope: { classId: number; sessionId: number; termId: number }, studentIds: number[]) {
  if (!studentIds.length) return;
  const staff = await reportStaff(tx, actor.schoolId, scope.classId);
  const ranges = await tx.select().from(schema.staffRemarkRanges).where(eq(schema.staffRemarkRanges.schoolId, actor.schoolId));
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
type RemarkInput = { studentId: number; sessionId: number; termId: number; role: string; remark: string };
function checkRemarkInput(input: RemarkInput) {
  if (![input.studentId, input.sessionId, input.termId].every(n => Number.isSafeInteger(n) && n > 0) ||
    !['principal', 'class_teacher'].includes(input.role) || typeof input.remark !== 'string' || input.remark.length > 500) fail('Choose a student, term and remark of at most 500 characters.');
}
export async function saveManualRemark(actor: Actor, input: RemarkInput) {
  checkRemarkInput(input);
  return forSchool(actor.schoolId, async tx => {
    await lockResultTerm(tx, actor.schoolId, input.sessionId, input.termId);
    await writeManualRemark(tx, actor, input);
  });
}
/** The remark write itself, inside a transaction the caller already opened and locked. */
async function writeManualRemark(tx: Tx, actor: Actor, input: RemarkInput) {
  {
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
  }
}

/** Whole days only, and a child cannot have been present more days than the term had. */
export function validAttendance(present: unknown, total: unknown): { present: number; total: number } {
  const p = Number(present), t = Number(total);
  if (!Number.isInteger(p) || !Number.isInteger(t) || p < 0 || t < 0 || t > 366) fail('Days present and days school was open must be whole numbers, and the term cannot have more than 366 days.');
  if (p > t) fail('Days present cannot be more than the days school was open.');
  return { present: p, total: t };
}

/** The classes this account is class teacher of (the principal and vice principal see none here: remarks are the class teacher's own). */
async function ownClasses(tx: Tx, actor: Actor) {
  if (!actor.staffId) return [];
  return tx.select({ id: schema.classes.id, name: schema.classes.displayName }).from(schema.staffAssignments)
    .innerJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId)).where(and(
      eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId),
      eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active')));
}

/** One class for one term: every active pupil with the remark and attendance already on file and whether it can still change. */
export async function classTermSheet(actor: Actor, classId: number | null) {
  return forSchool(actor.schoolId, async tx => {
    await settingsAccess(tx, actor);
    const classes = await ownClasses(tx, actor);
    const chosen = classes.find(c => c.id === classId) ?? classes[0] ?? null;
    const [session] = await tx.select().from(schema.academicSessions).where(and(eq(schema.academicSessions.schoolId, actor.schoolId), eq(schema.academicSessions.isCurrent, true)));
    const [term] = session ? await tx.select().from(schema.terms).where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.sessionId, session.id), eq(schema.terms.isCurrent, true))) : [];
    if (!chosen || !session || !term) return { classes, chosen, session: session ?? null, term: term ?? null, rows: [] as never[] };
    const pupils = await tx.select({ id: schema.students.id, firstName: schema.students.firstName, lastName: schema.students.lastName })
      .from(schema.enrollments).innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, chosen.id),
        eq(schema.enrollments.sessionId, session.id), eq(schema.enrollments.status, 'active'))).orderBy(schema.students.lastName, schema.students.firstName);
    const ids = pupils.map(p => p.id);
    const remarks = ids.length ? await tx.select().from(schema.reportRemarks).where(and(inArray(schema.reportRemarks.studentId, ids),
      eq(schema.reportRemarks.sessionId, session.id), eq(schema.reportRemarks.termId, term.id), eq(schema.reportRemarks.role, 'class_teacher'))) : [];
    const summaries = ids.length ? await tx.select().from(schema.termSummaries).where(and(eq(schema.termSummaries.schoolId, actor.schoolId),
      inArray(schema.termSummaries.studentId, ids), eq(schema.termSummaries.termId, term.id))) : [];
    const results = ids.length ? await tx.select({ studentId: schema.subjectResults.studentId, state: schema.subjectResults.state, published: schema.subjectResults.published })
      .from(schema.subjectResults).where(and(inArray(schema.subjectResults.studentId, ids), eq(schema.subjectResults.sessionId, session.id), eq(schema.subjectResults.termId, term.id))) : [];
    const rows = pupils.map(p => {
      const own = results.filter(r => r.studentId === p.id);
      const summary = summaries.find(s => s.studentId === p.id);
      const manual = remarks.find(r => r.studentId === p.id);
      return { studentId: p.id, name: `${p.lastName} ${p.firstName}`.trim(),
        remark: manual?.remark ?? (summary?.classTeacherRemark?.trim() ? summary.classTeacherRemark : ''), source: manual?.source ?? (summary?.classTeacherRemark?.trim() ? 'imported' : null),
        present: summary?.daysPresent ?? 0, total: summary?.daysTotal ?? 0,
        // Same rule saveManualRemark enforces: results must still be before review.
        locked: own.length === 0 || own.some(r => !['draft', 'compiled'].includes(r.state) || r.published) };
    });
    return { classes, chosen, session, term, rows };
  });
}

/** One pupil's class-teacher remark and attendance, saved together or not at all (one transaction, one lock). */
export async function saveTermNotes(actor: Actor, input: { studentId: number; sessionId: number; termId: number; remark: string; present: unknown; total: unknown }) {
  const days = validAttendance(input.present, input.total);
  const remark: RemarkInput = { studentId: input.studentId, sessionId: input.sessionId, termId: input.termId, role: 'class_teacher', remark: input.remark };
  checkRemarkInput(remark);
  return forSchool(actor.schoolId, async tx => {
    await lockResultTerm(tx, actor.schoolId, input.sessionId, input.termId);
    // Runs every guard: own class only, active enrolment, results still before review.
    await writeManualRemark(tx, actor, remark);
    const [enrolment] = await tx.select().from(schema.enrollments).where(and(eq(schema.enrollments.studentId, input.studentId),
      eq(schema.enrollments.sessionId, input.sessionId), eq(schema.enrollments.status, 'active')));
    const [before] = await tx.select().from(schema.termSummaries).where(and(eq(schema.termSummaries.studentId, input.studentId), eq(schema.termSummaries.termId, input.termId)));
    const after = { schoolId: actor.schoolId, studentId: input.studentId, sessionId: input.sessionId, termId: input.termId, classId: enrolment!.classId,
      daysPresent: days.present, daysTotal: days.total, updatedAt: new Date() };
    await tx.insert(schema.termSummaries).values(after).onConflictDoUpdate({ target: [schema.termSummaries.studentId, schema.termSummaries.termId],
      set: { daysPresent: days.present, daysTotal: days.total, classId: enrolment!.classId, updatedAt: new Date() } });
    await audit(tx, actor, 'attendance', before ?? null, after);
  });
}
