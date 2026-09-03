/**
 * The CBT engine.
 *
 * Four rules, each of which exists because the alternative fails in a hall full
 * of students:
 *
 *   1. TIME IS THE SERVER'S. `expiresAt` is computed at start and is the only
 *      thing that decides whether an answer is accepted. A device clock can be
 *      wound back; a closed laptop does not pause the examination.
 *
 *   2. ONE ATTEMPT PER STUDENT PER PAPER. Starting again resumes; it never
 *      restarts. A second start would silently discard the first set of
 *      answers, and the candidate would not know until results.
 *
 *   3. SAVING IS IDEMPOTENT. A dropped connection leaves the browser unsure
 *      whether the answer landed, so it retries. The save is an upsert keyed on
 *      (attempt, question), so a retry updates rather than duplicates.
 *
 *   4. NOTHING TELLS THE CANDIDATE WHETHER THEY WERE RIGHT. Not on save, not on
 *      submit. A response that echoes correctness turns the paper into an
 *      answer key.
 */

import { and, eq, sql, inArray, lt } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import { paperForCandidateTx, type PublicQuestion } from './paper';

export type StartResult =
  | { ok: true; attemptId: number; expiresAt: Date; questions: PublicQuestion[]; resumed: boolean }
  | { ok: false; reason:
    | 'not_published' | 'not_registered' | 'already_submitted' | 'no_questions'
    // Sitting-window refusals, formal examinations only.
    | 'not_scheduled' | 'window_not_open' | 'window_closed' };

/**
 * Start or resume.
 *
 * Registration is checked here, not in the UI. A student who never registered
 * the subject does not sit it, whatever link they were sent.
 */
export async function startAttempt(
  schoolId: number,
  paperId: number,
  studentId: number,
): Promise<StartResult> {
  return forSchool(schoolId, async (tx) => {
    const [paper] = await tx.select().from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, schoolId),
      )).limit(1);

    if (!paper || paper.status !== 'published') return { ok: false, reason: 'not_published' };

    // Registration is authoritative. In the WordPress system this read
    // "registered OR enrolled in the class", which made registration optional
    // and let students sit subjects they do not offer.
    const [registered] = await tx.select({ id: schema.studentSubjects.id })
      .from(schema.studentSubjects)
      .where(and(
        eq(schema.studentSubjects.studentId, studentId),
        eq(schema.studentSubjects.subjectId, paper.subjectId),
      )).limit(1);

    if (!registered) return { ok: false, reason: 'not_registered' };

    const [existing] = await tx.select().from(schema.attempts)
      .where(and(
        eq(schema.attempts.paperId, paperId),
        eq(schema.attempts.studentId, studentId),
      )).limit(1);

    if (existing) {
      if (existing.status !== 'in_progress') return { ok: false, reason: 'already_submitted' };

      await tx.insert(schema.attemptEvents).values({
        schoolId, attemptId: Number(existing.id), eventType: 'resumed',
      });

      return {
        ok: true,
        attemptId: Number(existing.id),
        expiresAt: existing.expiresAt,
        // The SAME order as before. Recomputing the shuffle would reorder the
        // paper mid-examination, which is indistinguishable from cheating
        // prevention gone wrong.
        // The tx this callback already owns — paperForCandidate() here would
        // open a second forSchool on a one-connection pool and never return.
        questions: await paperForCandidateTx(tx, schoolId, existing.questionOrder),
        resumed: true,
      };
    }

    /**
     * THE SITTING WINDOW, enforced by the server for scheduled examinations.
     *
     * The browser's clock is not authority: a candidate arriving before the
     * window opens, or after it closes, is refused here. A PRACTICE paper is
     * exempt — practice is always available. The check runs only for a NEW
     * attempt; a resume above has already passed it, so a candidate whose
     * attempt is still open is never locked out mid-examination.
     */
    const [series] = await tx.select({
      t: schema.examSeries.seriesType,
      opensAt: schema.examSeries.sittingOpensAt,
      closesAt: schema.examSeries.sittingClosesAt,
    })
      .from(schema.examSeries)
      .where(eq(schema.examSeries.id, paper.seriesId))
      .limit(1);

    const formal = series?.t === 'examination' || series?.t === 'ca_test';

    if (formal) {
      if (!series?.opensAt || !series?.closesAt) {
        return { ok: false, reason: 'not_scheduled' };
      }

      const now = Date.now();

      if (now < series.opensAt.getTime()) return { ok: false, reason: 'window_not_open' };
      if (now > series.closesAt.getTime()) return { ok: false, reason: 'window_closed' };
    }

    const pool = await tx.select({ questionId: schema.paperQuestions.questionId })
      .from(schema.paperQuestions)
      .where(eq(schema.paperQuestions.paperId, paperId));

    if (pool.length === 0) return { ok: false, reason: 'no_questions' };

    let ids = pool.map((p) => Number(p.questionId));

    if (paper.shuffleQuestions) ids = shuffle(ids);

    // A paper asking for more questions than the pool holds gives everyone the
    // whole pool rather than failing — a short pool is the setter's problem to
    // fix, not a reason to stop a candidate sitting.
    const take = paper.questionCount > 0 ? Math.min(paper.questionCount, ids.length) : ids.length;
    const chosen = ids.slice(0, take);

    const expiresAt = new Date(Date.now() + paper.durationSeconds * 1000);

    const [attempt] = await tx.insert(schema.attempts).values({
      schoolId, paperId, studentId,
      expiresAt,
      questionOrder: chosen,
    }).returning();

    return {
      ok: true,
      attemptId: Number(attempt!.id),
      expiresAt,
      questions: await paperForCandidateTx(tx, schoolId, chosen),
      resumed: false,
    };
  });
}

/**
 * Save one answer.
 *
 * Returns whether it was accepted and nothing else. In particular it does not
 * say whether the answer was right.
 */
export async function saveAnswer(
  schoolId: number,
  attemptId: number,
  studentId: number,
  input: { questionId: number; optionId?: number | null; text?: string | null; idempotencyKey?: string },
): Promise<{ ok: boolean; reason?: 'expired' | 'not_yours' | 'closed' }> {
  return forSchool(schoolId, async (tx) => {
    const [attempt] = await tx.select().from(schema.attempts)
      .where(and(
        eq(schema.attempts.id, attemptId),
        eq(schema.attempts.schoolId, schoolId),
      )).limit(1);

    if (!attempt || Number(attempt.studentId) !== studentId) {
      return { ok: false, reason: 'not_yours' as const };
    }

    if (attempt.status !== 'in_progress') return { ok: false, reason: 'closed' as const };

    // Server time decides. Not the client's countdown.
    const deadline = new Date(attempt.expiresAt.getTime() + attempt.extensionSeconds * 1000);

    if (new Date() > deadline) return { ok: false, reason: 'expired' as const };

    // The question must belong to THIS candidate's paper. Without this check a
    // student could post answers to questions they were never shown.
    if (!attempt.questionOrder.includes(input.questionId)) {
      return { ok: false, reason: 'not_yours' as const };
    }

    await tx.insert(schema.attemptAnswers).values({
      schoolId,
      attemptId,
      questionId: input.questionId,
      optionId: input.optionId ?? null,
      textAnswer: input.text ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [schema.attemptAnswers.attemptId, schema.attemptAnswers.questionId],
      set: {
        optionId: input.optionId ?? null,
        textAnswer: input.text ?? null,
        updatedAt: new Date(),
      },
    });

    await tx.update(schema.attempts)
      .set({ lastSyncedAt: new Date() })
      .where(eq(schema.attempts.id, attemptId));

    return { ok: true };
  });
}

/**
 * Submit.
 *
 * Marks objective answers server-side. Theory answers are left for the subject
 * teacher, so `score` covers only what can be marked automatically.
 */
export async function submitAttempt(
  schoolId: number,
  attemptId: number,
  studentId: number,
  auto = false,
): Promise<{ ok: boolean; reason?: string }> {
  return forSchool(schoolId, async (tx) => {
    const [attempt] = await tx.select().from(schema.attempts)
      .where(and(
        eq(schema.attempts.id, attemptId),
        eq(schema.attempts.schoolId, schoolId),
      )).limit(1);

    if (!attempt) return { ok: false, reason: 'not found' };

    if (!auto && Number(attempt.studentId) !== studentId) {
      return { ok: false, reason: 'not yours' };
    }

    // Submitting twice is a no-op, not an error. A retried submit after a
    // dropped response must not fail in front of a candidate.
    if (attempt.status !== 'in_progress') return { ok: true };

    const answers = await tx.select({
      questionId: schema.attemptAnswers.questionId,
      optionId: schema.attemptAnswers.optionId,
    })
      .from(schema.attemptAnswers)
      .where(eq(schema.attemptAnswers.attemptId, attemptId));

    const correct = await tx.select({
      questionId: schema.questionOptions.questionId,
      optionId: schema.questionOptions.id,
      marks: schema.questions.marks,
      type: schema.questions.questionType,
    })
      .from(schema.questionOptions)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.questionOptions.questionId))
      .where(and(
        inArray(schema.questionOptions.questionId, attempt.questionOrder),
        eq(schema.questionOptions.isCorrect, true),
      ));

    const key = new Map(correct.map((c) => [
      Number(c.questionId),
      { optionId: Number(c.optionId), marks: Number(c.marks) },
    ]));

    let score = 0;
    let maxScore = 0;

    for (const [, expected] of key) maxScore += expected.marks;

    for (const answer of answers) {
      const expected = key.get(Number(answer.questionId));

      if (!expected) continue;

      const right = answer.optionId !== null && Number(answer.optionId) === expected.optionId;

      if (right) score += expected.marks;

      await tx.update(schema.attemptAnswers)
        .set({ awardedMarks: String(right ? expected.marks : 0), markedAt: new Date() })
        .where(and(
          eq(schema.attemptAnswers.attemptId, attemptId),
          eq(schema.attemptAnswers.questionId, Number(answer.questionId)),
        ));
    }

    await tx.update(schema.attempts)
      .set({
        status: auto ? 'auto_submitted' : 'submitted',
        submittedAt: new Date(),
        score: String(score),
        maxScore: String(maxScore),
      })
      .where(eq(schema.attempts.id, attemptId));

    return { ok: true };
  });
}

/**
 * Close attempts whose time has run out.
 *
 * Runs on a schedule. The client cannot be trusted to submit on expiry: the tab
 * may be closed, the machine asleep, or the timer tampered with. An attempt
 * left open would otherwise accept answers indefinitely.
 */
export async function sweepExpired(schoolId: number): Promise<number> {
  const ids = await forSchool(schoolId, async (tx) => {
    const rows = await tx.select({ id: schema.attempts.id, studentId: schema.attempts.studentId })
      .from(schema.attempts)
      .where(and(
        eq(schema.attempts.status, 'in_progress'),
        lt(
          sql`${schema.attempts.expiresAt} + (${schema.attempts.extensionSeconds} * interval '1 second')`,
          new Date(),
        ),
      ));

    return rows.map((r) => ({ id: Number(r.id), studentId: Number(r.studentId) }));
  });

  for (const a of ids) await submitAttempt(schoolId, a.id, a.studentId, true);

  return ids.length;
}

/** Record an integrity signal. Advisory; see the note on attemptEventType. */
export async function recordEvent(
  schoolId: number,
  attemptId: number,
  eventType: 'window_blur' | 'tab_hidden' | 'right_click' | 'fullscreen_exit',
): Promise<void> {
  await forSchool(schoolId, async (tx) => {
    const [attempt] = await tx.select({ status: schema.attempts.status })
      .from(schema.attempts).where(eq(schema.attempts.id, attemptId)).limit(1);

    // A closed attempt stops accumulating incidents. Otherwise a stray tab
    // keeps reporting against a finished paper.
    if (!attempt || attempt.status !== 'in_progress') return;

    await tx.insert(schema.attemptEvents).values({ schoolId, attemptId, eventType });

    await tx.update(schema.attempts)
      .set({ integrityCount: sql`${schema.attempts.integrityCount} + 1` })
      .where(eq(schema.attempts.id, attemptId));
  });
}

function shuffle<T>(input: T[]): T[] {
  const out = [...input];

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }

  return out;
}
