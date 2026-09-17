/**
 * Marking Status — the principal/exam-office overview (legacy templates/
 * portal/exams/marking.php, school-wide half). Distinct from markingQueue()
 * in results.ts, which is the teacher's own "answers waiting for you" list.
 *
 * Three questions a principal actually asks on this page:
 *  1. Is anyone sitting on written scripts across the whole school?
 *  2. Which teachers have (or have not) recorded their CA components yet?
 *  3. Of the exams that have been sat, how much theory marking is left?
 */

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { currentSessionId } from '@/lib/people/students';
import { resultConfig } from '@/lib/results/config';

const SAT_STATUSES: ('submitted' | 'auto_submitted')[] = ['submitted', 'auto_submitted'];

export type PendingByTeacher = { teacherId: number; teacherName: string; subjectName: string; count: number };

/** Section 1 — "Marking status by teacher": written answers still unmarked, school-wide. */
export async function schoolMarkingStatus(actor: Actor): Promise<{ total: number; rows: PendingByTeacher[] }> {
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({
        teacherId: schema.staff.id,
        teacherName: sql<string>`${schema.staff.firstName} || ' ' || ${schema.staff.lastName}`,
        subjectName: schema.subjects.name,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(schema.attemptAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
      .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptAnswers.attemptId))
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .innerJoin(schema.staffAssignments, and(
        eq(schema.staffAssignments.subjectId, schema.subjects.id),
        eq(schema.staffAssignments.status, 'active'),
      ))
      .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
      .where(and(
        eq(schema.attemptAnswers.schoolId, actor.schoolId),
        eq(schema.questions.questionType, 'theory'),
        isNull(schema.attemptAnswers.awardedMarks),
        inArray(schema.attempts.status, SAT_STATUSES),
      ))
      .groupBy(schema.staff.id, schema.staff.firstName, schema.staff.lastName, schema.subjects.name)
      .orderBy(desc(sql`count(*)`));

    const total = rows.reduce((sum, r) => sum + r.count, 0);
    return { total, rows };
  });
}

export type CaProgressRow = {
  teacherId: number;
  teacherName: string;
  subjectId: number;
  subjectName: string;
  classId: number;
  className: string;
  recorded: { key: string; label: string; done: boolean }[];
  doneCount: number;
  totalCount: number;
  status: 'not_started' | 'in_progress' | 'all_recorded';
};

/** Section 2 — "CA assessment progress by teacher": components recorded per teacher/subject/class. */
export async function caProgressByTeacher(
  actor: Actor,
  filters: { teacherId?: number; subjectId?: number } = {},
): Promise<{
  rows: CaProgressRow[]; teachers: { id: number; name: string }[]; subjects: { id: number; name: string }[];
  components: { key: string; label: string }[];
}> {
  return forSchool(actor.schoolId, async (tx) => {
    const [school] = await tx.select({ settings: schema.schools.settings })
      .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);
    const config = resultConfig((school?.settings as Record<string, unknown>) ?? {});
    const components = config?.assessmentComponents ?? [];
    if (components.length === 0) return { rows: [], teachers: [], subjects: [], components: [] };

    const sessionId = await currentSessionId(tx, actor.schoolId);
    const [term] = await tx.select({ id: schema.terms.id })
      .from(schema.terms)
      .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.sessionId, sessionId), eq(schema.terms.isCurrent, true)))
      .limit(1);
    const termId = term?.id ?? 0;

    const assignments = await tx
      .select({
        teacherId: schema.staff.id,
        teacherName: sql<string>`${schema.staff.firstName} || ' ' || ${schema.staff.lastName}`,
        subjectId: schema.subjects.id,
        subjectName: schema.subjects.name,
        classId: schema.classes.id,
        className: schema.classes.displayName,
      })
      .from(schema.staffAssignments)
      .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId))
      .innerJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId))
      .where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId),
        eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
        eq(schema.staffAssignments.status, 'active'),
        eq(schema.classes.status, 'active'),
        filters.teacherId ? eq(schema.staff.id, filters.teacherId) : sql`true`,
        filters.subjectId ? eq(schema.subjects.id, filters.subjectId) : sql`true`,
      ))
      .orderBy(asc(schema.staff.lastName), asc(schema.subjects.name), asc(schema.classes.displayName));

    if (assignments.length === 0 || termId === 0) {
      const teachers = await tx.select({ id: schema.staff.id, name: sql<string>`${schema.staff.firstName} || ' ' || ${schema.staff.lastName}` })
        .from(schema.staff).where(and(eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active')))
        .orderBy(asc(schema.staff.lastName));
      const subjects = await tx.select({ id: schema.subjects.id, name: schema.subjects.name })
        .from(schema.subjects).where(eq(schema.subjects.schoolId, actor.schoolId)).orderBy(asc(schema.subjects.name));
      return { rows: [], teachers, subjects, components: components.map((c) => ({ key: c.key, label: c.label })) };
    }

    // Which (subjectId, classId, componentKey) have at least one score entered
    // for a student in that class, this term. One query for every CA
    // component; the exam component is answered from subject_results instead.
    const caKeys = components.filter((c) => !c.isExam).map((c) => c.key);
    const scoreRows = caKeys.length
      ? await tx
          .select({
            subjectId: schema.assessmentScores.subjectId,
            componentKey: schema.assessmentScores.componentKey,
            classId: schema.enrollments.classId,
          })
          .from(schema.assessmentScores)
          .innerJoin(schema.enrollments, and(
            eq(schema.enrollments.studentId, schema.assessmentScores.studentId),
            eq(schema.enrollments.sessionId, schema.assessmentScores.sessionId),
            eq(schema.enrollments.status, 'active'),
          ))
          .where(and(
            eq(schema.assessmentScores.schoolId, actor.schoolId),
            eq(schema.assessmentScores.sessionId, sessionId),
            eq(schema.assessmentScores.termId, termId),
            inArray(schema.assessmentScores.componentKey, caKeys),
          ))
          .groupBy(schema.assessmentScores.subjectId, schema.assessmentScores.componentKey, schema.enrollments.classId)
      : [];
    const recordedCa = new Set(scoreRows.map((r) => `${r.subjectId}:${r.classId}:${r.componentKey}`));

    const examRows = await tx
      .select({ subjectId: schema.subjectResults.subjectId, classId: schema.enrollments.classId })
      .from(schema.subjectResults)
      .innerJoin(schema.enrollments, and(
        eq(schema.enrollments.studentId, schema.subjectResults.studentId),
        eq(schema.enrollments.sessionId, schema.subjectResults.sessionId),
        eq(schema.enrollments.status, 'active'),
      ))
      .where(and(
        eq(schema.subjectResults.schoolId, actor.schoolId),
        eq(schema.subjectResults.sessionId, sessionId),
        eq(schema.subjectResults.termId, termId),
        sql`${schema.subjectResults.examTotal} > 0`,
      ))
      .groupBy(schema.subjectResults.subjectId, schema.enrollments.classId);
    const recordedExam = new Set(examRows.map((r) => `${r.subjectId}:${r.classId}`));

    const rows: CaProgressRow[] = assignments.map((a) => {
      const recorded = components.map((c) => ({
        key: c.key,
        label: c.label,
        done: c.isExam
          ? recordedExam.has(`${a.subjectId}:${a.classId}`)
          : recordedCa.has(`${a.subjectId}:${a.classId}:${c.key}`),
      }));
      const doneCount = recorded.filter((r) => r.done).length;
      const totalCount = recorded.length;
      return {
        teacherId: a.teacherId, teacherName: a.teacherName,
        subjectId: a.subjectId, subjectName: a.subjectName,
        classId: a.classId, className: a.className,
        recorded, doneCount, totalCount,
        status: doneCount === 0 ? 'not_started' : doneCount === totalCount ? 'all_recorded' : 'in_progress',
      };
    });

    const teachers = await tx.select({ id: schema.staff.id, name: sql<string>`${schema.staff.firstName} || ' ' || ${schema.staff.lastName}` })
      .from(schema.staff).where(and(eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active')))
      .orderBy(asc(schema.staff.lastName));
    const subjects = await tx.select({ id: schema.subjects.id, name: schema.subjects.name })
      .from(schema.subjects).where(eq(schema.subjects.schoolId, actor.schoolId)).orderBy(asc(schema.subjects.name));

    return { rows, teachers, subjects, components: components.map((c) => ({ key: c.key, label: c.label })) };
  });
}

export type CompletedExamMarking = {
  paperId: number; subjectName: string; className: string | null;
  totalTheory: number; markedTheory: number;
};

/** Section 3 — "Completed exams — marking status": theory marking left, per sat paper. */
export async function completedExamsMarkingStatus(actor: Actor): Promise<CompletedExamMarking[]> {
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({
        paperId: schema.examPapers.id,
        subjectName: schema.subjects.name,
        className: schema.classes.displayName,
        totalTheory: sql<number>`count(${schema.attemptAnswers.id})`.mapWith(Number),
        markedTheory: sql<number>`sum(case when ${schema.attemptAnswers.awardedMarks} is not null then 1 else 0 end)`.mapWith(Number),
      })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .leftJoin(schema.classes, eq(schema.classes.id, schema.examPapers.classId))
      .innerJoin(schema.attempts, and(eq(schema.attempts.paperId, schema.examPapers.id), inArray(schema.attempts.status, SAT_STATUSES)))
      .innerJoin(schema.attemptAnswers, eq(schema.attemptAnswers.attemptId, schema.attempts.id))
      .innerJoin(schema.questions, and(eq(schema.questions.id, schema.attemptAnswers.questionId), eq(schema.questions.questionType, 'theory')))
      .where(eq(schema.examPapers.schoolId, actor.schoolId))
      .groupBy(schema.examPapers.id, schema.subjects.name, schema.classes.displayName)
      .orderBy(desc(schema.examPapers.id));

    return rows;
  });
}
