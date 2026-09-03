/**
 * Practice papers: discovery and post-submission feedback.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PRACTICE / FORMAL SEPARATION, ENFORCED HERE
 *
 * Practice and examination are different series types with different rules.
 * Practice exists for learning: it can be sat any time, it does not count
 * towards results, and it earns feedback the moment it is submitted.
 * A formal examination earns NO feedback — the school publishes results
 * through compilation, and a marking key handed to a candidate as they leave
 * the hall would end that.
 *
 * The guard is NOT a hidden button. `practiceFeedback` refuses a formal
 * attempt at the service boundary, so no route, page or future UI change can
 * reach the marking key of an examination through this module.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import { forSchool, schema } from '@/db';

/**
 * What the practice area lists. Server-derived eligibility only: the
 * registration join decides what appears, never the browser.
 */
export type PracticePaperRow = {
  paperId: number;
  seriesId: number;
  seriesTitle: string;
  subjectName: string;
  subjectCode: string;
  durationSeconds: number;
  questionCount: number;
  attemptId: number | null;
  // All attempt statuses may appear here; the UI buckets them into
  // available / in progress / completed.
  attemptStatus: 'in_progress' | 'submitted' | 'auto_submitted' | 'expired' | 'cancelled' | null;
  score: number | null;
};

export async function practicePapersFor(
  schoolId: number,
  studentId: number,
): Promise<PracticePaperRow[]> {
  return forSchool(schoolId, async (tx) =>
    tx
      .select({
        paperId: schema.examPapers.id,
        seriesId: schema.examSeries.id,
        seriesTitle: schema.examSeries.title,
        subjectName: schema.subjects.name,
        subjectCode: schema.subjects.code,
        durationSeconds: schema.examPapers.durationSeconds,
        questionCount: schema.examPapers.questionCount,
        attemptId: schema.attempts.id,
        attemptStatus: schema.attempts.status,
        score: schema.attempts.score,
      })
      .from(schema.examPapers)
      .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      // The join that enforces registration — same rule as formal papers.
      .innerJoin(schema.studentSubjects, and(
        eq(schema.studentSubjects.subjectId, schema.examPapers.subjectId),
        eq(schema.studentSubjects.studentId, studentId),
      ))
      .leftJoin(schema.attempts, and(
        eq(schema.attempts.paperId, schema.examPapers.id),
        eq(schema.attempts.studentId, studentId),
      ))
      .where(and(
        eq(schema.examPapers.schoolId, schoolId),
        eq(schema.examPapers.status, 'published'),
        eq(schema.examSeries.seriesType, 'practice'),
        eq(schema.examSeries.status, 'published'),
      ))
      .orderBy(asc(schema.subjects.name), asc(schema.examSeries.id))
      .limit(100),
  ).then((rows) => rows.map((r) => ({
    paperId: Number(r.paperId),
    seriesId: Number(r.seriesId),
    seriesTitle: r.seriesTitle,
    subjectName: r.subjectName,
    subjectCode: r.subjectCode,
    durationSeconds: Number(r.durationSeconds),
    questionCount: Number(r.questionCount),
    attemptId: r.attemptId === null ? null : Number(r.attemptId),
    attemptStatus: r.attemptStatus ?? null,
    score: r.score === null ? null : Number(r.score),
  })));
}

/**
 * Feedback for ONE practice question. Deliberately narrow.
 *
 * Note what is NOT here: the marking guide, the approval state, moderation
 * metadata, vault/snapshot information — anything an examiner sees that a
 * learner has no use for. The explanation is included because practice is for
 * learning; it is never part of the live candidate payload.
 */
export type PracticeQuestionFeedback = {
  number: number;
  questionId: number;
  text: string;
  imageUrl: string | null;
  marks: number;
  awardedMarks: number;
  attempted: boolean;
  studentOptionText: string | null;
  correctOptionText: string | null;
  isCorrect: boolean;
  explanation: string | null;
};

export type PracticeFeedback = {
  title: string;
  subjectName: string;
  attemptId: number;
  submittedAt: string | null;
  score: number;
  maxScore: number;
  percentage: number;
  numberCorrect: number;
  numberAttempted: number;
  questions: PracticeQuestionFeedback[];
};

export type PracticeFeedbackResult =
  | { ok: true; feedback: PracticeFeedback }
  | { ok: false; reason: 'not_found' | 'not_yours' | 'formal_exam' | 'not_submitted' };

/**
 * Feedback for a submitted practice attempt.
 *
 * Refusal reasons, all decided SERVER-side:
 *
 * - `not_found`      — the attempt does not exist in this school, or was
 *                      submitted by nobody the caller knows. A student from
 *                      another school scanning attempt ids learns nothing,
 *                      not even whether the id exists.
 * - `not_yours`      — the attempt exists here but belongs to another student.
 * - `formal_exam`    — the attempt belongs to an examination series. This is
 *                      the hard guard: rejected whatever the attempt's status,
 *                      so no route or client can reach a formal marking key.
 * - `not_submitted`  — the attempt is still open. Feedback before submission
 *                      is an answer key by another name.
 */
export async function practiceFeedback(
  schoolId: number,
  attemptId: number,
  studentId: number,
): Promise<PracticeFeedbackResult> {
  return forSchool(schoolId, async (tx) => {
    const [attempt] = await tx
      .select({
        id: schema.attempts.id,
        studentId: schema.attempts.studentId,
        status: schema.attempts.status,
        score: schema.attempts.score,
        submittedAt: schema.attempts.submittedAt,
        questionOrder: schema.attempts.questionOrder,
        paperId: schema.attempts.paperId,
      })
      .from(schema.attempts)
      .where(and(
        eq(schema.attempts.id, attemptId),
        eq(schema.attempts.schoolId, schoolId),
      ))
      .limit(1);

    if (!attempt) return { ok: false, reason: 'not_found' } as const;

    if (Number(attempt.studentId) !== studentId) {
      return { ok: false, reason: 'not_yours' } as const;
    }

    const [context] = await tx
      .select({
        seriesType: schema.examSeries.seriesType,
        seriesTitle: schema.examSeries.title,
        subjectName: schema.subjects.name,
      })
      .from(schema.attempts)
      .innerJoin(schema.examPapers, eq(schema.examPapers.id, schema.attempts.paperId))
      .innerJoin(schema.examSeries, eq(schema.examSeries.id, schema.examPapers.seriesId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .where(eq(schema.attempts.id, attemptId))
      .limit(1);

    // THE GUARD. Checked before any answer data is read, and before the
    // submitted check — a formal attempt is refused even once submitted.
    if (context?.seriesType !== 'practice') {
      return { ok: false, reason: 'formal_exam' } as const;
    }

    if (attempt.status === 'in_progress') {
      return { ok: false, reason: 'not_submitted' } as const;
    }

    const questionOrder = (attempt.questionOrder ?? []) as number[];

    // The candidate's own answers, with the marks submitAttempt awarded.
    const answerRows = await tx
      .select({
        questionId: schema.attemptAnswers.questionId,
        optionId: schema.attemptAnswers.optionId,
        awardedMarks: schema.attemptAnswers.awardedMarks,
      })
      .from(schema.attemptAnswers)
      .where(eq(schema.attemptAnswers.attemptId, attemptId));

    const answerByQuestion = new Map(answerRows.map((a) => [
      Number(a.questionId),
      { optionId: a.optionId === null ? null : Number(a.optionId), awarded: a.awardedMarks },
    ]));

    // Question text and the explanation, for practice only.
    const questionRows = questionOrder.length
      ? await tx
          .select({
            id: schema.questions.id,
            text: schema.questions.questionText,
            imageUrl: schema.questions.imageUrl,
            marks: schema.questions.marks,
            explanation: schema.questions.explanation,
          })
          .from(schema.questions)
          .where(and(
            inArray(schema.questions.id, questionOrder),
            eq(schema.questions.schoolId, schoolId),
          ))
      : [];

    const questionById = new Map(questionRows.map((q) => [Number(q.id), q]));

    // Student's chosen option and the correct one. Reading options here is
    // safe: the attempt is submitted and the series is practice.
    const optionRows = questionOrder.length
      ? await tx
          .select({
            id: schema.questionOptions.id,
            questionId: schema.questionOptions.questionId,
            text: schema.questionOptions.optionText,
            isCorrect: schema.questionOptions.isCorrect,
          })
          .from(schema.questionOptions)
          .where(inArray(schema.questionOptions.questionId, questionOrder))
          .orderBy(asc(schema.questionOptions.sortOrder))
      : [];

    const optionById = new Map(optionRows.map((o) => [Number(o.id), o]));
    const correctByQuestion = new Map<number, string>();
    for (const o of optionRows) {
      if (o.isCorrect) correctByQuestion.set(Number(o.questionId), o.text);
    }

    let score = 0;
    let maxScore = 0;
    let numberCorrect = 0;
    let numberAttempted = 0;

    const questions: PracticeQuestionFeedback[] = questionOrder.map((questionId, i) => {
      const question = questionById.get(questionId);
      const answer = answerByQuestion.get(questionId);
      const marks = question ? Number(question.marks) : 0;
      const awarded = answer ? Number(answer.awarded) : 0;
      const attempted = Boolean(answer?.optionId);
      const isCorrect = attempted && awarded > 0;

      maxScore += marks;
      score += awarded;
      if (attempted) numberAttempted += 1;
      if (isCorrect) numberCorrect += 1;

      return {
        number: i + 1,
        questionId,
        text: question?.text ?? '',
        imageUrl: question?.imageUrl ?? null,
        marks,
        awardedMarks: awarded,
        attempted,
        studentOptionText: answer?.optionId
          ? optionById.get(answer.optionId)?.text ?? null
          : null,
        correctOptionText: correctByQuestion.get(questionId) ?? null,
        isCorrect,
        explanation: question?.explanation ?? null,
      };
    });

    return {
      ok: true,
      feedback: {
        title: context!.seriesTitle,
        subjectName: context!.subjectName,
        attemptId,
        submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
        score,
        maxScore,
        percentage: maxScore > 0 ? Math.round((score / maxScore) * 100) : 0,
        numberCorrect,
        numberAttempted,
        questions,
      },
    } as const;
  });
}
