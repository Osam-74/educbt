import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { portalCalendar } from '@/lib/portal-dashboard';
import { markingQueue } from '@/lib/exam/results';

/**
 * A teacher's own dashboard (legacy templates/portal/teacher/index.php):
 * what they teach, the CA recording surface, the classes they head, and the
 * work waiting for them — marking. Everything is resolved from the session's
 * staffId inside forSchool, so a teacher can only ever see their own
 * assignments; nothing here trusts a URL parameter.
 *
 * A class teacher is an assignment, not a role: "Classes I Head" comes from
 * staff_assignments rows of type class_teacher, exactly like the shell nav.
 */

export type TeacherClassAssignment = { classId: number; className: string; students: number };
export type TeacherSubject = { subjectId: number; subjectName: string; classes: TeacherClassAssignment[] };
export type TeacherHeadedClass = { classId: number; className: string; students: number; pipeline: { state: string; students: number }[] };

export async function teacherDashboard(actor: Actor) {
  if (actor.role !== 'teacher' || !actor.staffId) return null;
  const staffId = actor.staffId;

  // The marking queue is its own forSchool read; keep it out of the block
  // below rather than nesting two transactions on one pool.
  const marking = await markingQueue(actor);
  const outstanding = marking.length;
  const markingBySubject = new Map<string, number>();
  for (const row of marking) {
    markingBySubject.set(row.subjectName, (markingBySubject.get(row.subjectName) ?? 0) + 1);
  }

  const calendar = await portalCalendar(actor);
  return forSchool(actor.schoolId, async tx => {
    const held = await tx.select({
      classId: schema.staffAssignments.classId,
      subjectId: schema.staffAssignments.subjectId,
      type: schema.staffAssignments.assignmentType,
      className: schema.classes.displayName,
      subjectName: schema.subjects.name,
    })
      .from(schema.staffAssignments)
      .innerJoin(schema.classes, and(
        eq(schema.classes.id, schema.staffAssignments.classId),
        eq(schema.classes.schoolId, actor.schoolId),
        eq(schema.classes.status, 'active'),
      ))
      .leftJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId))
      .where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId),
        eq(schema.staffAssignments.staffId, staffId),
        eq(schema.staffAssignments.status, 'active'),
      ))
      .orderBy(asc(schema.classes.displayName), asc(schema.subjects.name));

    // Per-class student counts, scoped to the current session when one exists
    // (legacy counted plain active enrolments; scoping to the session keeps
    // the number honest once old sessions accumulate).
    const classSizes = await tx.select({ classId: schema.enrollments.classId, n: sql<number>`count(distinct ${schema.enrollments.studentId})`.mapWith(Number) })
      .from(schema.enrollments)
      .where(and(
        eq(schema.enrollments.schoolId, actor.schoolId),
        eq(schema.enrollments.status, 'active'),
        ...(calendar.session ? [eq(schema.enrollments.sessionId, calendar.session.id)] : []),
      ))
      .groupBy(schema.enrollments.classId);
    const sizeOf = new Map(classSizes.map(c => [c.classId, c.n]));

    // A class-teacher assignment is about heading a class, not teaching a
    // subject in it — it must never leak into the Record CA card.
    const subjectRows = held.filter(h => h.type === 'subject_teacher' && h.subjectId !== null && h.subjectName);
    const headRows = held.filter(h => h.type === 'class_teacher');

    const subjects: TeacherSubject[] = [];
    for (const row of subjectRows) {
      let entry = subjects.find(s => s.subjectId === row.subjectId);
      if (!entry) { entry = { subjectId: row.subjectId!, subjectName: row.subjectName!, classes: [] }; subjects.push(entry); }
      entry.classes.push({ classId: row.classId!, className: row.className!, students: sizeOf.get(row.classId!) ?? 0 });
    }
    subjects.sort((a, b) => a.subjectName.localeCompare(b.subjectName));

    // Results pipeline for classes this teacher heads — read-only states for
    // the current term. Class results management stays a school-wide workflow;
    // the dashboard only reports where each headed class stands.
    const headedIds = headRows.map(h => h.classId!);
    let pipelineByClass = new Map<number, { state: string; students: number }[]>();
    if (headedIds.length && calendar.session && calendar.term) {
      const r = schema.subjectResults, e = schema.enrollments;
      const rows = await tx.select({ classId: e.classId, state: r.state, students: sql<number>`count(distinct ${r.studentId})`.mapWith(Number) })
        .from(r)
        .innerJoin(e, and(
          eq(e.studentId, r.studentId),
          eq(e.sessionId, r.sessionId),
          eq(e.schoolId, r.schoolId),
          eq(e.status, 'active'),
          inArray(e.classId, headedIds),
        ))
        .where(and(
          eq(r.schoolId, actor.schoolId),
          eq(r.sessionId, calendar.session.id),
          eq(r.termId, calendar.term.id),
        ))
        .groupBy(e.classId, r.state).orderBy(asc(r.state));
      pipelineByClass = new Map<number, { state: string; students: number }[]>();
      for (const row of rows) {
        const list = pipelineByClass.get(row.classId) ?? [];
        list.push({ state: row.state, students: row.students });
        pipelineByClass.set(row.classId, list);
      }
    }

    const headed: TeacherHeadedClass[] = headRows.map(h => ({
      classId: h.classId!,
      className: h.className!,
      students: sizeOf.get(h.classId!) ?? 0,
      pipeline: pipelineByClass.get(h.classId!) ?? [],
    }));

    // Questions this teacher authored, across the school's question sets.
    const [written] = await tx.select({ n: count() }).from(schema.questions)
      .innerJoin(schema.questionSets, eq(schema.questionSets.id, schema.questions.questionSetId))
      .where(and(
        eq(schema.questionSets.schoolId, actor.schoolId),
        eq(schema.questionSets.teacherId, staffId),
      ));

    return {
      ...calendar,
      subjects,
      headed,
      myStudents: headed.reduce((total, c) => total + c.students, 0),
      marking: {
        outstanding,
        subjects: [...markingBySubject.entries()].map(([subjectName, answers]) => ({ subjectName, answers })).sort((a, b) => a.subjectName.localeCompare(b.subjectName)),
      },
      questionsWritten: written?.n ?? 0,
    };
  });
}
