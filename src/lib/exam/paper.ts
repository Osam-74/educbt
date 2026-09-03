/**
 * Serving a paper to a candidate.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE MOST IMPORTANT RULE IN THIS CODEBASE
 *
 * Correct answers must never reach the browser.
 *
 * Not "should not appear in the UI" — must never be SENT. A student with the
 * network tab open reads every payload the server returns. If `isCorrect` is in
 * one of them, every examination ever sat on the platform is invalid, and you
 * will not find out until a result is disputed.
 *
 * This file is the ONLY sanctioned path from question storage to a candidate's
 * screen. Everything it returns is a `PublicQuestion`, a type that has no field
 * for correctness and therefore cannot carry one by accident.
 *
 * Marking happens in `markAttempt()`, server-side, against the database.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { and, eq, asc, inArray } from 'drizzle-orm';
import { forSchool, schema } from '@/db';

/**
 * What a candidate is allowed to see.
 *
 * Deliberately narrow. Adding `isCorrect` here would be a visible, reviewable
 * change to a type named "public", rather than a field that quietly rides along
 * inside a `select *`.
 */
export type PublicOption = {
  id: number;
  key: string | null;
  text: string;
  imageUrl: string | null;
};

export type PublicQuestion = {
  id: number;
  number: number;
  text: string;
  type: string;
  imageUrl: string | null;
  instructions: string | null;
  marks: number;
  section: string;
  passage: { id: number; title: string; body: string; imageUrl: string | null } | null;
  options: PublicOption[];
};

/**
 * Build the paper a candidate sits.
 *
 * Note what is NOT selected: `isCorrect`, `markingGuide`, `explanation`,
 * `approvalStatus`. Each would be a leak of a different kind — the answer, the
 * marker's notes, the reasoning, or the review state.
 */
export async function paperForCandidate(
  schoolId: number,
  questionIds: number[],
): Promise<PublicQuestion[]> {
  if (questionIds.length === 0) return [];

  return forSchool(schoolId, (tx) => paperForCandidateTx(tx, schoolId, questionIds));
}

/**
 * The same paper, on a transaction the CALLER owns.
 *
 * `startAttempt` runs inside a forSchool transaction, and the shared pool holds
 * exactly one connection — calling paperForCandidate() from there waits for a
 * second connection that will never come, hanging the student at the start
 * button forever. Passing the caller's transaction in is the only safe shape.
 */
export async function paperForCandidateTx(
  tx: Parameters<Parameters<typeof forSchool>[1]>[0],
  schoolId: number,
  questionIds: number[],
): Promise<PublicQuestion[]> {
  if (questionIds.length === 0) return [];

  {
    const rows = await tx
      .select({
        id: schema.questions.id,
        text: schema.questions.questionText,
        type: schema.questions.questionType,
        imageUrl: schema.questions.imageUrl,
        instructions: schema.questions.instructions,
        marks: schema.questions.marks,
        section: schema.questions.section,
        sequence: schema.questions.sequence,
        passageId: schema.questions.passageId,
      })
      .from(schema.questions)
      .where(and(
        inArray(schema.questions.id, questionIds),
        eq(schema.questions.schoolId, schoolId),
        eq(schema.questions.status, 'active'),
      ))
      .orderBy(asc(schema.questions.sequence), asc(schema.questions.id));

    // Options: id, key, text, image. No correctness column is named, so none
    // can be returned.
    const optionRows = await tx
      .select({
        id: schema.questionOptions.id,
        questionId: schema.questionOptions.questionId,
        key: schema.questionOptions.optionKey,
        text: schema.questionOptions.optionText,
        imageUrl: schema.questionOptions.imageUrl,
        sortOrder: schema.questionOptions.sortOrder,
      })
      .from(schema.questionOptions)
      .where(inArray(schema.questionOptions.questionId, rows.map((r) => r.id)))
      .orderBy(asc(schema.questionOptions.sortOrder));

    const passageIds = rows
      .map((r) => r.passageId)
      .filter((id): id is number => id !== null);

    const passageRows = passageIds.length
      ? await tx
          .select({
            id: schema.passages.id,
            title: schema.passages.title,
            body: schema.passages.body,
            imageUrl: schema.passages.imageUrl,
          })
          .from(schema.passages)
          .where(inArray(schema.passages.id, passageIds))
      : [];

    const passageById = new Map(passageRows.map((p) => [Number(p.id), p]));

    const optionsByQuestion = new Map<number, PublicOption[]>();

    for (const o of optionRows) {
      const qid = Number(o.questionId);
      const list = optionsByQuestion.get(qid) ?? [];
      list.push({ id: Number(o.id), key: o.key, text: o.text, imageUrl: o.imageUrl });
      optionsByQuestion.set(qid, list);
    }

    return rows.map((r, i) => ({
      id: Number(r.id),
      number: i + 1,
      text: r.text,
      type: r.type,
      imageUrl: r.imageUrl,
      instructions: r.instructions,
      marks: Number(r.marks),
      section: r.section,
      passage: r.passageId ? passageById.get(Number(r.passageId)) ?? null : null,
      options: optionsByQuestion.get(Number(r.id)) ?? [],
    }));
  }
}

/**
 * Mark objective answers. Server-side, against the database, always.
 *
 * The client sends option ids. It is never told which were right, either before
 * the paper or in the response — a marking endpoint that echoes correctness back
 * turns every submission into an answer key.
 */
export async function markObjective(
  schoolId: number,
  answers: Array<{ questionId: number; optionId: number | null }>,
): Promise<{ score: number; total: number }> {
  if (answers.length === 0) return { score: 0, total: 0 };

  return forSchool(schoolId, async (tx) => {
    const questionIds = answers.map((a) => a.questionId);

    const correct = await tx
      .select({
        questionId: schema.questionOptions.questionId,
        optionId: schema.questionOptions.id,
        marks: schema.questions.marks,
      })
      .from(schema.questionOptions)
      .innerJoin(schema.questions, eq(schema.questions.id, schema.questionOptions.questionId))
      .where(and(
        inArray(schema.questionOptions.questionId, questionIds),
        eq(schema.questionOptions.isCorrect, true),
        eq(schema.questions.schoolId, schoolId),
      ));

    const correctByQuestion = new Map<number, { optionId: number; marks: number }>();

    for (const c of correct) {
      correctByQuestion.set(Number(c.questionId), {
        optionId: Number(c.optionId),
        marks: Number(c.marks),
      });
    }

    let score = 0;
    let total = 0;

    for (const answer of answers) {
      const expected = correctByQuestion.get(answer.questionId);

      // A question with no correct option recorded is a question that cannot be
      // marked. It contributes nothing to the total either, so a setter's
      // mistake never costs the candidate marks.
      if (!expected) continue;

      total += expected.marks;

      if (answer.optionId !== null && answer.optionId === expected.optionId) {
        score += expected.marks;
      }
    }

    return { score, total };
  });
}
