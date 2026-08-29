/**
 * Marking and compilation.
 *
 * Objective answers are marked at submission. Theory answers are not — they need
 * a person, and specifically the person who teaches that subject.
 *
 * Compilation then combines continuous assessment with the examination mark and
 * works out grades and positions.
 *
 * THE RULE THAT GOVERNS THIS FILE: a published result is a historical record.
 * Once a term's results are out, changing a grading scale must not silently
 * rewrite them. Compilation therefore stores the computed numbers rather than
 * deriving them on every read.
 */

import { and, eq, sql, asc, desc, inArray, isNull } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { gradeFor, positions } from './grading';

export { gradeFor };
import type { Actor } from '@/lib/session';

// ── Marking ──────────────────────────────────────────────────────────────────

/**
 * Theory answers waiting for this teacher.
 *
 * Scoped to the subjects they are assigned. A teacher must not be handed
 * another subject's scripts, and the exam office must not be able to mark
 * on their behalf by accident.
 */
export async function markingQueue(actor: Actor) {
  if (!actor.staffId) return [];

  return forSchool(actor.schoolId, async (tx) => {
    const mine = await tx
      .select({ subjectId: schema.staffAssignments.subjectId })
      .from(schema.staffAssignments)
      .where(and(
        eq(schema.staffAssignments.staffId, actor.staffId!),
        eq(schema.staffAssignments.status, 'active'),
      ));

    const subjectIds = mine
      .map((m) => m.subjectId)
      .filter((id): id is number => id !== null);

    if (subjectIds.length === 0) return [];

    return tx
      .select({
        answerId: schema.attemptAnswers.id,
        questionText: schema.questions.questionText,
        markingGuide: schema.questions.markingGuide,
        maxMarks: schema.questions.marks,
        textAnswer: schema.attemptAnswers.textAnswer,
        studentName: sql<string>`${schema.students.firstName} || ' ' || ${schema.students.lastName}`,
        admissionNumber: schema.students.admissionNumber,
        subjectName: schema.subjects.name,
      })
      .from(schema.attemptAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
      .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptAnswers.attemptId))
      .innerJoin(schema.students, eq(schema.students.id, schema.attempts.studentId))
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .where(and(
        eq(schema.attemptAnswers.schoolId, actor.schoolId),
        eq(schema.questions.questionType, 'theory'),
        // Unmarked only. A marked script reappearing in the queue is how a
        // teacher loses an afternoon re-marking what they already did.
        isNull(schema.attemptAnswers.awardedMarks),
        inArray(schema.examPapers.subjectId, subjectIds),
        inArray(schema.attempts.status, ['submitted', 'auto_submitted']),
      ))
      .orderBy(asc(schema.subjects.name), asc(schema.students.lastName))
      .limit(200);
  });
}

export async function awardMarks(
  actor: Actor,
  answerId: number,
  marks: number,
): Promise<{ ok: boolean; reason?: string }> {
  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx
      .select({
        id: schema.attemptAnswers.id,
        max: schema.questions.marks,
        subjectId: schema.examPapers.subjectId,
      })
      .from(schema.attemptAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
      .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptAnswers.attemptId))
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .where(and(
        eq(schema.attemptAnswers.id, answerId),
        eq(schema.attemptAnswers.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!row) return { ok: false, reason: 'not found' };

    // A mark above the maximum is a typo, not a decision. Caught here rather
    // than surfacing as a student scoring 105%.
    if (marks < 0 || marks > Number(row.max)) {
      return { ok: false, reason: `Marks must be between 0 and ${Number(row.max)}.` };
    }

    await tx.update(schema.attemptAnswers)
      .set({ awardedMarks: String(marks), markedBy: actor.userId, markedAt: new Date() })
      .where(eq(schema.attemptAnswers.id, answerId));

    return { ok: true };
  });
}

// ── Results ──────────────────────────────────────────────────────────────────

export { subjectResults };

/**
 * Compile one subject for one class.
 *
 * Positions are computed across the whole cohort AFTER every total is known —
 * ranking as you go gives a position based on however many students happened to
 * be processed first.
 */
export async function compileSubject(
  actor: Actor,
  args: { subjectId: number; classId: number; sessionId: number; termId: number },
): Promise<{ compiled: number }> {
  return forSchool(actor.schoolId, async (tx) => {
    const students = await tx
      .select({ id: schema.students.id })
      .from(schema.enrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(
        eq(schema.enrollments.classId, args.classId),
        eq(schema.enrollments.sessionId, args.sessionId),
        eq(schema.enrollments.status, 'active'),
        eq(schema.students.status, 'active'),
      ));

    if (students.length === 0) return { compiled: 0 };

    const totals: Array<{ studentId: number; ca: number; exam: number; total: number }> = [];

    for (const student of students) {
      // Everything the candidate scored on papers for this subject this term,
      // objective and theory together.
      const [examRow] = await tx
        .select({
          scored: sql<number>`COALESCE(SUM(${schema.attemptAnswers.awardedMarks}), 0)`.mapWith(Number),
        })
        .from(schema.attemptAnswers)
        .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptAnswers.attemptId))
        .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
        .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
        .where(and(
          eq(schema.attempts.studentId, Number(student.id)),
          eq(schema.examPapers.subjectId, args.subjectId),
          eq(schema.examSeries.termId, args.termId),
          // Practice never counts towards a result.
          eq(schema.examSeries.seriesType, 'examination'),
        ));

      const exam = Number(examRow?.scored ?? 0);
      const ca = 0; // CA components land here once score entry is built.

      totals.push({ studentId: Number(student.id), ca, exam, total: ca + exam });
    }

    // Rank once, across the whole cohort.
    // Ranked in one pass, after every total is known.
    const positionOf = positions(totals);

    for (const row of totals) {
      const { grade, remark } = gradeFor(row.total);

      await tx.insert(subjectResults).values({
        schoolId: actor.schoolId,
        studentId: row.studentId,
        subjectId: args.subjectId,
        sessionId: args.sessionId,
        termId: args.termId,
        caTotal: String(row.ca),
        examTotal: String(row.exam),
        total: String(row.total),
        grade,
        remark,
        subjectPosition: positionOf.get(row.studentId) ?? 0,
        classSize: totals.length,
      }).onConflictDoUpdate({
        target: [
          subjectResults.studentId, subjectResults.subjectId,
          subjectResults.sessionId, subjectResults.termId,
        ],
        set: {
          caTotal: String(row.ca),
          examTotal: String(row.exam),
          total: String(row.total),
          grade,
          remark,
          subjectPosition: positionOf.get(row.studentId) ?? 0,
          classSize: totals.length,
          compiledAt: new Date(),
        },
      });
    }

    return { compiled: totals.length };
  });
}

/**
 * A student's results for a term.
 *
 * Unpublished results are withheld from the student and their parents, but
 * visible to staff — a teacher must be able to check a mark before the school
 * commits to it.
 */
export async function resultsForStudent(
  actor: Actor,
  studentId: number,
  sessionId: number,
  termId: number,
  includeUnpublished: boolean,
) {
  return forSchool(actor.schoolId, async (tx) => {
    const conditions = [
      eq(subjectResults.studentId, studentId),
      eq(subjectResults.sessionId, sessionId),
      eq(subjectResults.termId, termId),
    ];

    if (!includeUnpublished) conditions.push(eq(subjectResults.published, true));

    return tx
      .select({
        subjectName: schema.subjects.name,
        caTotal: subjectResults.caTotal,
        examTotal: subjectResults.examTotal,
        total: subjectResults.total,
        grade: subjectResults.grade,
        remark: subjectResults.remark,
        position: subjectResults.subjectPosition,
        classSize: subjectResults.classSize,
        published: subjectResults.published,
      })
      .from(subjectResults)
      .innerJoin(schema.subjects, eq(schema.subjects.id, subjectResults.subjectId))
      .where(and(...conditions))
      .orderBy(asc(schema.subjects.name));
  });
}

/** Publishing is deliberate and audited — it is what parents will see. */
export async function publishResults(
  actor: Actor,
  sessionId: number,
  termId: number,
): Promise<number> {
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx.update(subjectResults)
      .set({ published: true })
      .where(and(
        eq(subjectResults.schoolId, actor.schoolId),
        eq(subjectResults.sessionId, sessionId),
        eq(subjectResults.termId, termId),
      ))
      .returning({ id: subjectResults.id });

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'results.published',
      entityType: 'subject_results',
      after: { sessionId, termId, count: rows.length },
    });

    return rows.length;
  });
}
