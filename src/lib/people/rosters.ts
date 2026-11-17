import { and, asc, eq, inArray } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { currentSessionId } from '@/lib/people/students';

/**
 * Roster exports for teachers.
 *
 *  - A CLASS TEACHER downloads the students of a class they head.
 *  - A SUBJECT TEACHER downloads the students of a class who are actually
 *    REGISTERED for the subject they teach there. Registration, not class
 *    size: electives mean a class of 40 may have only 12 taking Further Maths.
 *
 * Both fail closed: a class or subject the actor does not hold returns null,
 * never another teacher's students. There is deliberately NO row cap (the
 * on-screen roster is capped at 500; an export must not silently truncate).
 * Read-only: nothing here writes.
 */

export type RosterStudent = {
  admissionNumber: string;
  lastName: string;
  firstName: string;
  gender: string | null;
  status: string;
  parentName: string | null;
  parentPhone: string | null;
  parentEmail: string | null;
};

export type Roster = {
  title: string;
  className: string;
  subjectName: string | null;
  sessionTitle: string;
  students: RosterStudent[];
};

const STUDENT_COLUMNS = {
  admissionNumber: schema.students.admissionNumber,
  lastName: schema.students.lastName,
  firstName: schema.students.firstName,
  gender: schema.students.gender,
  status: schema.students.status,
  parentName: schema.students.parentName,
  parentPhone: schema.students.parentPhone,
  parentEmail: schema.students.parentEmail,
};

/** Classes this actor heads as class teacher (no wide-role shortcut: a
 *  principal exporting a roster uses the Students page, not this). */
async function headedIds(actor: Actor): Promise<number[]> {
  if (!actor.staffId) return [];
  return forSchool(actor.schoolId, async (tx) => (await tx
    .select({ classId: schema.staffAssignments.classId }).from(schema.staffAssignments)
    .where(and(
      eq(schema.staffAssignments.schoolId, actor.schoolId),
      eq(schema.staffAssignments.staffId, actor.staffId!),
      eq(schema.staffAssignments.assignmentType, 'class_teacher'),
      eq(schema.staffAssignments.status, 'active'),
    ))).map((r) => r.classId).filter((id): id is number => id !== null));
}

/** The class teacher's roster for one class they head, or null. */
export async function classTeacherRoster(actor: Actor, classId: number): Promise<Roster | null> {
  if (!(await headedIds(actor)).includes(classId)) return null;

  return forSchool(actor.schoolId, async (tx) => {
    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) return null;
    const [cls] = await tx.select({ name: schema.classes.displayName }).from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
    const [session] = await tx.select({ title: schema.academicSessions.title }).from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.id, sessionId), eq(schema.academicSessions.schoolId, actor.schoolId))).limit(1);
    if (!cls) return null;

    const students = await tx.select(STUDENT_COLUMNS).from(schema.students)
      .innerJoin(schema.enrollments, and(
        eq(schema.enrollments.studentId, schema.students.id),
        eq(schema.enrollments.classId, classId),
        eq(schema.enrollments.sessionId, sessionId),
        eq(schema.enrollments.status, 'active'),
      ))
      .where(and(
        eq(schema.students.schoolId, actor.schoolId),
        inArray(schema.students.status, ['active', 'pending_approval']),
      ))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    return { title: `${cls.name} class list`, className: cls.name, subjectName: null, sessionTitle: session?.title ?? '', students };
  });
}

/** The subject teacher's roster: students of `classId` registered for
 *  `subjectId` this session, but only if the actor teaches that subject in
 *  that class. Otherwise null. */
export async function subjectTeacherRoster(actor: Actor, classId: number, subjectId: number): Promise<Roster | null> {
  if (!actor.staffId) return null;

  return forSchool(actor.schoolId, async (tx) => {
    const [held] = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments)
      .where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId),
        eq(schema.staffAssignments.staffId, actor.staffId!),
        eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
        eq(schema.staffAssignments.status, 'active'),
        eq(schema.staffAssignments.classId, classId),
        eq(schema.staffAssignments.subjectId, subjectId),
      )).limit(1);
    if (!held) return null;

    const sessionId = await currentSessionId(tx, actor.schoolId);
    if (!sessionId) return null;
    const [cls] = await tx.select({ name: schema.classes.displayName }).from(schema.classes)
      .where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
    const [subject] = await tx.select({ name: schema.subjects.name }).from(schema.subjects)
      .where(and(eq(schema.subjects.id, subjectId), eq(schema.subjects.schoolId, actor.schoolId))).limit(1);
    const [session] = await tx.select({ title: schema.academicSessions.title }).from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.id, sessionId), eq(schema.academicSessions.schoolId, actor.schoolId))).limit(1);
    if (!cls || !subject) return null;

    const students = await tx.select(STUDENT_COLUMNS).from(schema.students)
      .innerJoin(schema.enrollments, and(
        eq(schema.enrollments.studentId, schema.students.id),
        eq(schema.enrollments.classId, classId),
        eq(schema.enrollments.sessionId, sessionId),
        eq(schema.enrollments.status, 'active'),
      ))
      .innerJoin(schema.studentSubjects, and(
        eq(schema.studentSubjects.studentId, schema.students.id),
        eq(schema.studentSubjects.subjectId, subjectId),
        eq(schema.studentSubjects.sessionId, sessionId),
      ))
      .where(and(
        eq(schema.students.schoolId, actor.schoolId),
        inArray(schema.students.status, ['active', 'pending_approval']),
      ))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    return { title: `${subject.name} students, ${cls.name}`, className: cls.name, subjectName: subject.name, sessionTitle: session?.title ?? '', students };
  });
}

// ── CSV ────────────────────────────────────────────────────────────────

/** One CSV cell. Quotes when needed, and defuses spreadsheet formulas: a cell
 *  that starts with = + - @ (or tab/CR) would otherwise RUN when opened in
 *  Excel, and names/phones are typed by users. */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const ROSTER_HEADERS = ['No.', 'Admission No.', 'Surname', 'First name', 'Gender', 'Status', 'Parent / Guardian', 'Phone', 'Email'];

/** Excel needs the BOM to read UTF-8 names (Yoruba/Igbo diacritics) correctly. */
export function rosterToCsv(roster: Roster): string {
  const lines = [ROSTER_HEADERS.map(csvCell).join(',')];
  roster.students.forEach((s, i) => {
    lines.push([
      i + 1, s.admissionNumber, s.lastName, s.firstName, s.gender ?? '', s.status === 'pending_approval' ? 'Pending approval' : 'Active',
      s.parentName ?? '', s.parentPhone ?? '', s.parentEmail ?? '',
    ].map(csvCell).join(','));
  });
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/** A safe download file name: letters, digits, dashes only. */
export function rosterFileName(roster: Roster): string {
  const slug = `${roster.title}-${roster.sessionTitle}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'class-list'}.csv`;
}
