import { and, eq, asc } from 'drizzle-orm';
import { schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { loadReportSheet } from './sheet';
import { computeReportSheet } from './sheet-compute';

/**
 * Every student's terminal report sheet for one class and term, ready to print as a single run (one sheet per page).
 *
 * The rules are the plugin's bulk report, built on the single report rather than beside it:
 *  - Each sheet is loaded through loadReportSheet, the same function the single report uses, so the bulk print can
 *    never show a viewer a sheet the single report would refuse (school-wide staff see any class; a class teacher sees
 *    only the class they hold; a student or parent has no "class" and gets nothing here).
 *  - Only PUBLISHED sheets are printed. A student whose results are not yet published is left out and counted, so the
 *    page can say so instead of printing a half-finished sheet.
 *  - Order is last name, then first name, then admission number (a stable tie-break the plugin did not have).
 *
 * Returns null when the viewer may not print this class at all (no such class, or not theirs).
 */
export async function classReportSheets(tx: Tx, actor: Actor, classId: number, termId: number) {
  if (!['principal', 'vice_principal', 'exam_officer', 'teacher'].includes(actor.role)) return null;

  const [klass] = await tx.select({ id: schema.classes.id, name: schema.classes.displayName }).from(schema.classes)
    .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
  if (!klass) return null;

  const [term] = await tx.select({ id: schema.terms.id, title: schema.terms.title, sessionId: schema.terms.sessionId }).from(schema.terms)
    .where(and(eq(schema.terms.schoolId, actor.schoolId), termId ? eq(schema.terms.id, termId) : eq(schema.terms.isCurrent, true))).limit(1);
  if (!term) return null;

  // A teacher may print only a class they hold as class teacher (the same assignment reportAudience checks per student).
  if (actor.role === 'teacher') {
    if (!actor.staffId) return null;
    const [held] = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments)
      .where(and(eq(schema.staffAssignments.staffId, actor.staffId), eq(schema.staffAssignments.classId, classId),
        eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active'))).limit(1);
    if (!held) return null;
  }

  const students = await tx.select({ id: schema.students.id }).from(schema.enrollments)
    .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
    .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, classId),
      eq(schema.enrollments.sessionId, Number(term.sessionId)), eq(schema.enrollments.status, 'active')))
    .orderBy(asc(schema.students.lastName), asc(schema.students.firstName), asc(schema.students.admissionNumber));

  const sheets = [];
  let notPublished = 0;
  for (const s of students) {
    const data = await loadReportSheet(tx, actor, Number(s.id), Number(term.id));
    if (!data) { notPublished++; continue; }
    const sheet = computeReportSheet(data, Number(s.id));
    if (sheet.anyUnpublished || sheet.rows.length === 0) { notPublished++; continue; }
    sheets.push(sheet);
  }
  return { className: klass.name, termTitle: term.title, termId: Number(term.id), sheets, notPublished, enrolled: students.length };
}
