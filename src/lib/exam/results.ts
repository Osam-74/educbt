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

import { and, eq, sql, asc, inArray, isNull } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { gradeFor, isEditable, type ResultState } from '@/domain/academic';
import { compileClassResults, transitionClassResults, ResultError } from '@/lib/results/workflow';

import { caScoreSchema, type CaScoreInput } from '@/lib/ca/validation';
import { validateCaContext, caAssignment } from '@/lib/ca/access';
import { lockResultTerm } from '@/lib/ca/lock';

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
        studentId: schema.attempts.studentId,
        sessionId: schema.examSeries.sessionId,
        termId: schema.examSeries.termId,
        classId: schema.enrollments.classId,
      })
      .from(schema.attemptAnswers)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.attemptAnswers.questionId))
      .innerJoin(schema.attempts, eq(schema.attempts.id, schema.attemptAnswers.attemptId))
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .innerJoin(schema.enrollments, and(eq(schema.enrollments.studentId, schema.attempts.studentId),
        eq(schema.enrollments.sessionId, schema.examSeries.sessionId), eq(schema.enrollments.status, 'active')))
      .where(and(
        eq(schema.attemptAnswers.id, answerId),
        eq(schema.attemptAnswers.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!row || !row.termId) return { ok: false, reason: 'not found' };
    await lockResultTerm(tx, actor.schoolId, row.sessionId, row.termId);
    const [permitted] = await tx.select({ id: schema.users.id }).from(schema.users)
      .innerJoin(schema.schools, eq(schema.schools.id, schema.users.schoolId))
      .where(and(eq(schema.users.id, actor.userId), eq(schema.users.status, 'active'),
        eq(schema.users.role, actor.role as 'teacher'), eq(schema.schools.status, 'active'),
        caAssignment(tx, actor, row.classId, row.subjectId)));
    if (!permitted) return { ok: false, reason: 'You do not have permission to mark this script.' };
    const [result] = await tx.select().from(subjectResults).where(and(
      eq(subjectResults.studentId, row.studentId), eq(subjectResults.subjectId, row.subjectId),
      eq(subjectResults.sessionId, row.sessionId), eq(subjectResults.termId, row.termId)));
    if (result && (!isEditable(result.state) || result.published)) {
      return { ok: false, reason: 'Reopen reviewed, published or locked results before correcting examination marks.' };
    }

    // A mark above the maximum is a typo, not a decision. Caught here rather
    // than surfacing as a student scoring 105%.
    if (!Number.isFinite(marks) || marks < 0 || marks > Number(row.max)) {
      return { ok: false, reason: `Marks must be between 0 and ${Number(row.max)}.` };
    }

    await tx.update(schema.attemptAnswers)
      .set({ awardedMarks: String(marks), markedBy: actor.userId, markedAt: new Date() })
      .where(eq(schema.attemptAnswers.id, answerId));

    if (result?.state === 'compiled') await tx.update(subjectResults).set({ state: 'draft', complete: false }).where(eq(subjectResults.id, result.id));

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
  return compileClassResults(actor, args, args.subjectId);
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

/**
 * Move a term's results through the lifecycle.
 *
 * The permitted transitions live in the domain layer, so the rule is the same
 * whether it is applied here, in a screen, or in a future API. Moves that take
 * a result back from something a family has seen require a written reason, and
 * that reason goes to the audit log.
 */
export async function transitionResults(
  actor: Actor, sessionId: number, termId: number, to: ResultState, reason = '', classId?: number,
): Promise<{ ok: boolean; moved: number; error?: string }> {
  if (!classId) return { ok: false, moved: 0, error: 'Choose a class before changing result stages.' };
  try { return await transitionClassResults(actor, { classId, sessionId, termId }, to, reason); }
  catch (error) {
    if (error instanceof ResultError) return { ok: false, moved: 0, error: error.message };
    throw error;
  }
}

/** Enter or update a continuous assessment score. */
export async function enterScore(
  actor: Actor,
  args: CaScoreInput,
): Promise<{ ok: boolean; error?: string }> {
  if (!caScoreSchema.safeParse(args).success) return { ok: false, error: 'Enter a valid score and academic scope (at most two decimal places).' };
  if (args.score < 0 || args.score > args.maxScore) {
    return { ok: false, error: `Score must be between 0 and ${args.maxScore}.` };
  }

  return forSchool(actor.schoolId, async (tx) => {
    await lockResultTerm(tx, actor.schoolId, args.sessionId, args.termId);
    const error = await validateCaContext(tx, actor, args);
    if (error) return { ok: false, error };

    // A published term is closed to score entry. Changing a mark underneath a
    // result a family has already seen is exactly what the lifecycle prevents.
    const [existing] = await tx
      .select({ id: subjectResults.id, state: subjectResults.state, published: subjectResults.published })
      .from(subjectResults)
      .where(and(
        eq(subjectResults.schoolId, actor.schoolId),
        eq(subjectResults.sessionId, args.sessionId),
        eq(subjectResults.studentId, args.studentId),
        eq(subjectResults.subjectId, args.subjectId),
        eq(subjectResults.termId, args.termId),
      ))
      .limit(1).for('update');

    if (existing && (!isEditable(existing.state) || existing.published)) {
      return {
        ok: false,
        error: 'These results are reviewed, published or locked. Reopen them through the result lifecycle before changing a score.',
      };
    }

    await tx.insert(schema.assessmentScores).values({
      schoolId: actor.schoolId,
      studentId: args.studentId,
      subjectId: args.subjectId,
      sessionId: args.sessionId,
      termId: args.termId,
      componentKey: args.componentKey,
      score: String(args.score),
      maxScore: String(args.maxScore),
      enteredBy: actor.userId,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      // Matches the unique key exactly. A conflict target narrower than the
      // constraint silently updates the wrong row.
      target: [
        schema.assessmentScores.schoolId,
        schema.assessmentScores.studentId,
        schema.assessmentScores.subjectId,
        schema.assessmentScores.sessionId,
        schema.assessmentScores.termId,
        schema.assessmentScores.componentKey,
      ],
      set: {
        score: String(args.score),
        maxScore: String(args.maxScore),
        enteredBy: actor.userId,
        updatedAt: new Date(),
      },
    });

    // A changed score makes a prior compilation stale. It must be compiled again
    // before review/publication; preserve the historical totals until then.
    if (existing?.state === 'compiled') {
      await tx.update(subjectResults).set({ state: 'draft', complete: false })
        .where(eq(subjectResults.id, existing.id));
    }
    return { ok: true };
  });
}
