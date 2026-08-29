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
import {
  gradeFor, rank, computeTotal, canTransition, requiresReason,
  WAEC_NINE_POINT, DEFAULT_RANKING,
  type GradingScale, type RankingPolicy, type ResultState,
} from '@/domain/academic';

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
  args: {
    subjectId: number; classId: number; sessionId: number; termId: number;
    /**
     * Supplied by the caller so a school's own scale and tie policy apply.
     * Defaults exist so a school that has configured neither still compiles.
     */
    scale?: GradingScale;
    policy?: RankingPolicy;
  },
): Promise<{ compiled: number }> {
  const scale = args.scale ?? WAEC_NINE_POINT;
  const policy = args.policy ?? DEFAULT_RANKING;

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

    const totals: Array<{
      studentId: number; ca: number; exam: number; total: number; complete: boolean;
    }> = [];

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

      // Continuous assessment, entered by the subject teacher.
      const caRows = await tx
        .select({ score: schema.assessmentScores.score })
        .from(schema.assessmentScores)
        .where(and(
          eq(schema.assessmentScores.studentId, Number(student.id)),
          eq(schema.assessmentScores.subjectId, args.subjectId),
          eq(schema.assessmentScores.termId, args.termId),
        ));

      const ca = caRows.reduce((sum, r) => sum + Number(r.score), 0);

      // A student with no marks at all has not been assessed — recording 0%
      // and a Fail for them is worse than recording nothing.
      const complete = caRows.length > 0 || exam > 0;

      totals.push({ studentId: Number(student.id), ca, exam, total: ca + exam, complete });
    }

    // Rank once, across the whole cohort.
    // Ranked ONCE, with every total known. See src/domain/academic.ts.
    const ranked = rank(
      totals.map((t) => ({
        studentId: t.studentId,
        total: t.total,
        examTotal: t.exam,
        caTotal: t.ca,
        complete: t.complete,
      })),
      policy,
    );

    const positionOf = new Map(ranked.map((r) => [r.studentId, r.position ?? 0]));

    for (const row of totals) {
      const graded = gradeFor(row.total, scale);
      const { grade, remark } = graded;

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
        // The context that makes this grade and position explainable later.
        gradingScaleId: graded.scaleId,
        gradingScaleVersion: graded.scaleVersion,
        rankingPolicy: policy as unknown as Record<string, unknown>,
        complete: row.complete,
        state: 'compiled',
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
          gradingScaleId: graded.scaleId,
          gradingScaleVersion: graded.scaleVersion,
          rankingPolicy: policy as unknown as Record<string, unknown>,
          complete: row.complete,
          state: 'compiled',
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

/**
 * Move a term's results through the lifecycle.
 *
 * The permitted transitions live in the domain layer, so the rule is the same
 * whether it is applied here, in a screen, or in a future API. Moves that take
 * a result back from something a family has seen require a written reason, and
 * that reason goes to the audit log.
 */
export async function transitionResults(
  actor: Actor,
  sessionId: number,
  termId: number,
  to: ResultState,
  reason = '',
): Promise<{ ok: boolean; moved: number; error?: string }> {
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({ id: subjectResults.id, state: subjectResults.state })
      .from(subjectResults)
      .where(and(
        eq(subjectResults.schoolId, actor.schoolId),
        eq(subjectResults.sessionId, sessionId),
        eq(subjectResults.termId, termId),
      ));

    if (rows.length === 0) return { ok: false, moved: 0, error: 'Nothing compiled for that term.' };

    // Every row must be able to make the move. A partial transition would leave
    // one class published and another not, under the same term.
    const blocked = rows.filter((r) => !canTransition(r.state, to));

    if (blocked.length > 0) {
      return {
        ok: false,
        moved: 0,
        error: `${blocked.length} result(s) cannot move from ${blocked[0]!.state} to ${to}.`,
      };
    }

    const needsReason = rows.some((r) => requiresReason(r.state, to));

    if (needsReason && reason.trim().length < 10) {
      return {
        ok: false,
        moved: 0,
        error: 'Taking results back from a state families have seen requires a written reason.',
      };
    }

    const now = new Date();

    await tx.update(subjectResults)
      .set({
        state: to,
        published: to === 'published' || to === 'locked',
        ...(to === 'reviewed' ? { reviewedAt: now } : {}),
        ...(to === 'published' ? { publishedAt: now } : {}),
        ...(to === 'locked' ? { lockedAt: now } : {}),
      })
      .where(and(
        eq(subjectResults.schoolId, actor.schoolId),
        eq(subjectResults.sessionId, sessionId),
        eq(subjectResults.termId, termId),
      ));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: `results.${to}`,
      entityType: 'subject_results',
      before: { states: [...new Set(rows.map((r) => r.state))] },
      after: { state: to, count: rows.length, sessionId, termId },
      reason: reason || null,
    });

    return { ok: true, moved: rows.length };
  });
}

/** Enter or update a continuous assessment score. */
export async function enterScore(
  actor: Actor,
  args: {
    studentId: number; subjectId: number; sessionId: number; termId: number;
    componentKey: string; score: number; maxScore: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  if (args.score < 0 || args.score > args.maxScore) {
    return { ok: false, error: `Score must be between 0 and ${args.maxScore}.` };
  }

  return forSchool(actor.schoolId, async (tx) => {
    // A published term is closed to score entry. Changing a mark underneath a
    // result a family has already seen is exactly what the lifecycle prevents.
    const [existing] = await tx
      .select({ state: subjectResults.state })
      .from(subjectResults)
      .where(and(
        eq(subjectResults.studentId, args.studentId),
        eq(subjectResults.subjectId, args.subjectId),
        eq(subjectResults.termId, args.termId),
      ))
      .limit(1);

    if (existing && (existing.state === 'published' || existing.state === 'locked')) {
      return {
        ok: false,
        error: 'These results are published. Unpublish the term before changing a score.',
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
      target: [
        schema.assessmentScores.studentId, schema.assessmentScores.subjectId,
        schema.assessmentScores.termId, schema.assessmentScores.componentKey,
      ],
      set: {
        score: String(args.score),
        maxScore: String(args.maxScore),
        enteredBy: actor.userId,
        updatedAt: new Date(),
      },
    });

    return { ok: true };
  });
}
