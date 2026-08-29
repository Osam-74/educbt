/**
 * Question set authoring and review.
 *
 * The scope rules encoded here are the ones the WordPress system got wrong, in
 * the order it got them wrong:
 *
 *   1. A set is found by its FULL scope, including the series and the WAEC
 *      flag. Looking it up by subject and level alone returned the terminal
 *      examination when the teacher was writing a practice paper.
 *
 *   2. Paired submission applies to the terminal examination ONLY. A CA test
 *      and a practice paper are objective by design, so requiring a theory half
 *      meant their submit button could never enable — which reads as a broken
 *      button, not as a rule.
 *
 *   3. A question is 'pending' until somebody reads it. It defaulted to
 *      'approved' once, which meant every question a teacher typed was live
 *      before review.
 */

import { and, eq, count, asc, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { isSchoolWide } from '@/lib/queries';

export type SetScope = {
  sessionId: number;
  termId: number;
  subjectId: number;
  levelId: number;
  departmentId: number | null;
  examType: 'objective' | 'theory';
  seriesId: number;
  waecMode: boolean;
};

/**
 * Find the set for this exact scope, or create it.
 *
 * Every field of the scope is used. Omitting one is how two different papers
 * become the same row.
 */
export async function findOrCreateSet(actor: Actor, scope: SetScope) {
  return forSchool(actor.schoolId, async (tx) => {
    const where = and(
      eq(schema.questionSets.schoolId, actor.schoolId),
      eq(schema.questionSets.sessionId, scope.sessionId),
      eq(schema.questionSets.termId, scope.termId),
      eq(schema.questionSets.subjectId, scope.subjectId),
      eq(schema.questionSets.levelId, scope.levelId),
      scope.departmentId === null
        ? sql`${schema.questionSets.departmentId} IS NULL`
        : eq(schema.questionSets.departmentId, scope.departmentId),
      eq(schema.questionSets.examType, scope.examType),
      eq(schema.questionSets.seriesId, scope.seriesId),
      eq(schema.questionSets.waecMode, scope.waecMode),
    );

    const [existing] = await tx.select().from(schema.questionSets).where(where).limit(1);

    if (existing) return existing;

    const [created] = await tx.insert(schema.questionSets).values({
      schoolId: actor.schoolId,
      sessionId: scope.sessionId,
      termId: scope.termId,
      subjectId: scope.subjectId,
      levelId: scope.levelId,
      departmentId: scope.departmentId,
      examType: scope.examType,
      seriesId: scope.seriesId,
      waecMode: scope.waecMode,
      teacherId: actor.staffId,
      minRequired: scope.examType === 'objective' ? 20 : 4,
    }).returning();

    return created!;
  });
}

/** A set may only be edited before it is handed in. */
export function isEditable(status: string): boolean {
  return status === 'draft' || status === 'returned';
}

export async function addQuestion(
  actor: Actor,
  setId: number,
  input: {
    text: string;
    marks: number;
    section?: string;
    passageId?: number | null;
    instructions?: string | null;
    imageUrl?: string | null;
    noShuffle?: boolean;
    options?: Array<{ text: string; isCorrect: boolean }>;
  },
) {
  return forSchool(actor.schoolId, async (tx) => {
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      )).limit(1);

    if (!set) throw new Error('Question set not found.');

    if (!isEditable(set.status)) {
      throw new Error(
        'This set has been submitted and can no longer be edited. Ask the exam office to send it back.',
      );
    }

    // A teacher may only write into their own set.
    if (!isSchoolWide(actor.role) && set.teacherId !== actor.staffId) {
      throw new Error('This set belongs to another teacher.');
    }

    if (set.examType === 'objective') {
      const filled = (input.options ?? []).filter((o) => o.text.trim() !== '');

      if (filled.length < 2) {
        throw new Error('An objective question needs at least two options.');
      }

      if (!filled.some((o) => o.isCorrect)) {
        // Without this a question is unmarkable, and the failure surfaces only
        // when a candidate has already sat it.
        throw new Error('Mark which option is correct.');
      }
    }

    const [seqRow] = await tx
      .select({ next: sql<number>`COALESCE(MAX(${schema.questions.sequence}), 0) + 1`.mapWith(Number) })
      .from(schema.questions)
      .where(eq(schema.questions.questionSetId, setId));

    const [question] = await tx.insert(schema.questions).values({
      schoolId: actor.schoolId,
      questionSetId: setId,
      questionText: input.text,
      questionType: set.examType === 'theory' ? 'theory' : 'single_choice',
      marks: String(input.marks),
      section: input.section ?? '',
      passageId: input.passageId ?? null,
      instructions: input.instructions ?? null,
      imageUrl: input.imageUrl ?? null,
      noShuffle: input.noShuffle ?? false,
      sequence: seqRow?.next ?? 1,
      // Pending until a reviewer reads it. Never 'approved' on write.
      approvalStatus: 'pending',
    }).returning();

    if (set.examType === 'objective' && input.options) {
      const rows = input.options
        .filter((o) => o.text.trim() !== '')
        .map((o, i) => ({
          schoolId: actor.schoolId,
          questionId: Number(question!.id),
          optionKey: String.fromCharCode(65 + i),
          optionText: o.text.trim(),
          isCorrect: o.isCorrect,
          sortOrder: i,
        }));

      await tx.insert(schema.questionOptions).values(rows);
    }

    return question!;
  });
}

/**
 * Hand a set in for review.
 *
 * A terminal examination submits objective and theory TOGETHER. Submitting them
 * separately let a teacher hand in half a paper and left reviewers chasing the
 * other half. A CA test and a practice paper have no theory half, so they
 * submit alone.
 */
export async function submitSet(actor: Actor, setId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      )).limit(1);

    if (!set) throw new Error('Question set not found.');
    if (!isEditable(set.status)) throw new Error('This set has already been submitted.');

    const paired = set.seriesId === 0;

    const [own] = await tx.select({ n: count() }).from(schema.questions)
      .where(and(
        eq(schema.questions.questionSetId, setId),
        eq(schema.questions.status, 'active'),
      ));

    const shortfall: string[] = [];

    if ((own?.n ?? 0) < set.minRequired) {
      shortfall.push(`${set.examType}: ${own?.n ?? 0} of ${set.minRequired}`);
    }

    if (paired) {
      const siblingType = set.examType === 'objective' ? 'theory' : 'objective';

      const [sibling] = await tx.select().from(schema.questionSets)
        .where(and(
          eq(schema.questionSets.schoolId, actor.schoolId),
          eq(schema.questionSets.sessionId, set.sessionId),
          eq(schema.questionSets.termId, set.termId),
          eq(schema.questionSets.subjectId, set.subjectId),
          eq(schema.questionSets.levelId, set.levelId),
          eq(schema.questionSets.examType, siblingType),
          eq(schema.questionSets.seriesId, 0),
          eq(schema.questionSets.waecMode, set.waecMode),
        )).limit(1);

      if (!sibling) {
        shortfall.push(`${siblingType}: not started`);
      } else {
        const [sn] = await tx.select({ n: count() }).from(schema.questions)
          .where(and(
            eq(schema.questions.questionSetId, Number(sibling.id)),
            eq(schema.questions.status, 'active'),
          ));

        if ((sn?.n ?? 0) < sibling.minRequired) {
          shortfall.push(`${siblingType}: ${sn?.n ?? 0} of ${sibling.minRequired}`);
        }
      }

      if (shortfall.length > 0) {
        return { success: false as const, shortfall };
      }

      if (sibling) {
        await tx.update(schema.questionSets)
          .set({ status: 'submitted', submittedAt: new Date(), submittedBy: actor.userId })
          .where(eq(schema.questionSets.id, Number(sibling.id)));
      }
    } else if (shortfall.length > 0) {
      return { success: false as const, shortfall };
    }

    /**
     * A practice paper is never reviewed — it is not scheduled and nothing
     * rests on the result, so a review cycle would be skipped or rubber-stamped.
     * It goes straight to approved and is available to students immediately.
     */
    const [series] = set.seriesId > 0
      ? await tx.select({ t: schema.examSeries.seriesType }).from(schema.examSeries)
          .where(eq(schema.examSeries.id, set.seriesId)).limit(1)
      : [];

    const autoApprove = series?.t === 'practice' || series?.t === 'ca_test';

    await tx.update(schema.questionSets)
      .set({
        status: autoApprove ? 'approved' : 'submitted',
        submittedAt: new Date(),
        submittedBy: actor.userId,
        ...(autoApprove ? { reviewedAt: new Date(), reviewedBy: actor.userId } : {}),
      })
      .where(eq(schema.questionSets.id, setId));

    if (autoApprove) {
      await tx.update(schema.questions)
        .set({ approvalStatus: 'approved' })
        .where(eq(schema.questions.questionSetId, setId));
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: autoApprove ? 'question_set.auto_approved' : 'question_set.submitted',
      entityType: 'question_sets',
      entityId: setId,
    });

    return { success: true as const, autoApproved: autoApprove };
  });
}

/**
 * Review decision.
 *
 * The SET's status is derived from its questions rather than set independently,
 * so the two can never disagree — a set showing "approved" while holding a
 * question sent back for revision is how a paper reaches the hall incomplete.
 */
export async function reviewSet(
  actor: Actor,
  setId: number,
  decision: 'approve' | 'return',
  comment: string,
) {
  if (!isSchoolWide(actor.role)) {
    throw new Error('Only the exam office may review question sets.');
  }

  if (decision === 'return' && comment.trim().length < 10) {
    // A rejection without a reason is a rejection the teacher cannot act on.
    throw new Error('Give a reason of at least 10 characters when sending a set back.');
  }

  return forSchool(actor.schoolId, async (tx) => {
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      )).limit(1);

    if (!set) throw new Error('Question set not found.');

    await tx.update(schema.questions)
      .set({
        approvalStatus: decision === 'approve' ? 'approved' : 'revision',
        reviewedBy: actor.userId,
        reviewedAt: new Date(),
        ...(decision === 'return' ? { reviewerComment: comment } : {}),
      })
      .where(eq(schema.questions.questionSetId, setId));

    await tx.update(schema.questionSets)
      .set({
        status: decision === 'approve' ? 'approved' : 'returned',
        reviewedAt: new Date(),
        reviewedBy: actor.userId,
        reviewerComment: comment || null,
      })
      .where(eq(schema.questionSets.id, setId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: `question_set.${decision === 'approve' ? 'approved' : 'returned'}`,
      entityType: 'question_sets',
      entityId: setId,
      reason: comment || null,
    });

    return { success: true as const };
  });
}

/** Sets a teacher owns, or every submitted set for the exam office. */
export async function listSets(actor: Actor) {
  return forSchool(actor.schoolId, async (tx) => {
    const conditions = [eq(schema.questionSets.schoolId, actor.schoolId)];

    if (!isSchoolWide(actor.role)) {
      conditions.push(eq(schema.questionSets.teacherId, actor.staffId ?? -1));
    }

    return tx
      .select({
        id: schema.questionSets.id,
        status: schema.questionSets.status,
        examType: schema.questionSets.examType,
        waecMode: schema.questionSets.waecMode,
        seriesId: schema.questionSets.seriesId,
        minRequired: schema.questionSets.minRequired,
        subjectName: schema.subjects.name,
        subjectCode: schema.subjects.code,
        levelName: schema.classLevels.name,
        departmentName: schema.departments.name,
        questionCount: sql<number>`(
          SELECT count(*) FROM ${schema.questions} q
          WHERE q.question_set_id = ${schema.questionSets.id} AND q.status = 'active'
        )`.mapWith(Number),
      })
      .from(schema.questionSets)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionSets.subjectId))
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.questionSets.levelId))
      .leftJoin(schema.departments, eq(schema.departments.id, schema.questionSets.departmentId))
      .where(and(...conditions))
      .orderBy(asc(schema.subjects.name))
      .limit(200);
  });
}
