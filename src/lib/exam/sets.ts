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
import { authoringActor, authoringLock, permittedScope, permittedCollection, editableSetAccess } from './authoring-access';
import { validateQuestion } from './authoring-validation';

export type SetScope = {
  sessionId: number;
  termId: number;
  subjectId: number;
  levelId: number;
  departmentId: number | null;
  examType: 'objective' | 'theory';
  seriesId: number;
  waecMode: boolean;
  // Both optional: the scope key (unique index) does not include either, so
  // they are properties OF whichever row the scope resolves to, not part of
  // what makes two sets distinct. A teacher may flip CBT/Written or adjust the
  // per-question default without starting a new paper.
  deliveryMode?: 'cbt' | 'written';
  defaultMarks?: number | string;
};

/**
 * Find the set for this exact scope, or create it.
 *
 * Every field of the scope is used. Omitting one is how two different papers
 * become the same row.
 */
export async function findOrCreateSet(actor: Actor, scope: SetScope) {
  return forSchool(actor.schoolId, async (tx) => {
    await authoringLock(tx, actor.schoolId);
    const school = await permittedScope(tx, actor, scope);
    const quotas = await permittedCollection(tx, actor, scope, school.settings);
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

    if (existing) {
      if (!isSchoolWide(actor.role) && existing.teacherId !== actor.staffId) throw new Error('This set belongs to another teacher.');

      // Delivery mode and the default mark are adjustable right up until the set
      // is handed in — after that they describe work already submitted, so
      // leave them alone rather than silently rewriting a paper in review.
      const patch: Partial<typeof schema.questionSets.$inferInsert> = {};
      if (isEditable(existing.status)) {
        if (scope.deliveryMode && scope.deliveryMode !== existing.deliveryMode) patch.deliveryMode = scope.deliveryMode;
        const nextMarks = scope.defaultMarks !== undefined ? Number(scope.defaultMarks) : undefined;
        if (nextMarks && Number(existing.defaultMarks) !== nextMarks) patch.defaultMarks = String(nextMarks);
      }
      if (Object.keys(patch).length === 0) return existing;
      const [updated] = await tx.update(schema.questionSets).set(patch)
        .where(eq(schema.questionSets.id, existing.id)).returning();
      return updated!;
    }

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
      deliveryMode: scope.deliveryMode ?? 'cbt',
      defaultMarks: String(scope.defaultMarks ?? 1),
      teacherId: actor.staffId,
      minRequired: quotas[scope.examType],
    }).returning();

    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'question_set.created', entityType: 'question_sets', entityId: created!.id, after: scope });
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
    markingGuide?: string | null;
    options?: Array<{ text: string; isCorrect: boolean }>;
  },
) {
  return forSchool(actor.schoolId, async (tx) => {
    await authoringLock(tx, actor.schoolId);
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      )).limit(1);

    if (!set) throw new Error('Question set not found.');
    await editableSetAccess(tx, actor, set);
    input = validateQuestion(input, set.examType);
    const [duplicate] = await tx.select({ id: schema.questions.id }).from(schema.questions).where(and(
      eq(schema.questions.questionSetId, setId), eq(schema.questions.status, 'active'),
      sql`lower(trim(${schema.questions.questionText})) = lower(trim(${input.text}))`));
    if (duplicate) throw new Error('This question already exists in the set.');
    if (input.passageId) {
      const [passage] = await tx.select({ id: schema.passages.id }).from(schema.passages).where(and(
        eq(schema.passages.id, input.passageId), eq(schema.passages.schoolId, actor.schoolId),
        eq(schema.passages.subjectId, set.subjectId)));
      if (!passage) throw new Error('Choose a passage for this subject in this school.');
    }

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
      markingGuide: input.markingGuide ?? null,
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

    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'question.created', entityType: 'questions', entityId: question!.id, after: { setId, marks: input.marks } });
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
    await authoringLock(tx, actor.schoolId);
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      )).limit(1);

    if (!set) throw new Error('Question set not found.');
    await editableSetAccess(tx, actor, set);
    if (!isEditable(set.status)) throw new Error('This set has already been submitted.');

    // Written delivery means the school prints and marks the paper on paper —
    // there is no bank of typed questions to hold to a quota. The "submission"
    // is the intent itself, so it always clears, alone, with nothing to review.
    if (set.deliveryMode === 'written') {
      await tx.update(schema.questionSets)
        .set({ status: 'approved', submittedAt: new Date(), submittedBy: actor.userId, reviewedAt: new Date(), reviewedBy: actor.userId })
        .where(eq(schema.questionSets.id, setId));
      await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
        action: 'question_set.written_intent', entityType: 'question_sets', entityId: setId });
      return { success: true as const, autoApproved: true };
    }

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
          set.departmentId === null ? sql`${schema.questionSets.departmentId} IS NULL` : eq(schema.questionSets.departmentId, set.departmentId),
          eq(schema.questionSets.examType, siblingType),
          eq(schema.questionSets.seriesId, 0),
          eq(schema.questionSets.waecMode, set.waecMode),
        )).limit(1);

      if (!sibling) {
        shortfall.push(`${siblingType}: not started`);
      } else {
        await editableSetAccess(tx, actor, sibling);
        if (!isEditable(sibling.status) && sibling.status !== 'approved') throw new Error('The paired set is already awaiting review or published.');
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

      if (sibling && isEditable(sibling.status)) {
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
    await authoringLock(tx, actor.schoolId);
    await authoringActor(tx, actor);
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      )).limit(1);

    if (!set) throw new Error('Question set not found.');
    if (!['submitted', 'under_review'].includes(set.status)) throw new Error('Only a submitted set can be reviewed.');

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
    await authoringActor(tx, actor);
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

/**
 * Add several questions in one call — the shared landing point for Paste and
 * CSV import. Runs the exact same validation and duplicate/passage checks as
 * addQuestion, one row at a time, so a bulk import can never create a
 * question a manual entry would have refused. A row that fails is reported
 * back with its index and reason; earlier successful rows are NOT rolled
 * back, matching the legacy importer (a partial import is progress, not
 * nothing — the teacher pastes the same block again and only the failures
 * repeat, because the successes are now duplicates).
 */
export async function addQuestionsBulk(
  actor: Actor,
  setId: number,
  items: Array<{
    text: string;
    marks: number;
    section?: string;
    instructions?: string | null;
    markingGuide?: string | null;
    options?: Array<{ text: string; isCorrect: boolean }>;
  }>,
) {
  const added: number[] = [];
  const failed: Array<{ index: number; text: string; reason: string }> = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    try {
      const q = await addQuestion(actor, setId, item);
      added.push(Number(q.id));
    } catch (e) {
      failed.push({ index: i, text: item.text.slice(0, 60), reason: e instanceof Error ? e.message : 'Could not save this question.' });
    }
  }

  return { added: added.length, failed };
}

/**
 * Every submission the exam office has ever received, for the safekeeping
 * ledger — not just the pending queue (that is what /portal/exams/approvals'
 * review cards already show). Grouped into one row per paper (objective +
 * theory together), because that is how a teacher hands work in and how the
 * office thinks about "is this subject done yet".
 */
export async function listAllSubmissions(actor: Actor) {
  if (!isSchoolWide(actor.role)) throw new Error('Only the exam office can see every submission.');

  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.questionSets.id,
        examType: schema.questionSets.examType,
        deliveryMode: schema.questionSets.deliveryMode,
        waecMode: schema.questionSets.waecMode,
        status: schema.questionSets.status,
        minRequired: schema.questionSets.minRequired,
        submittedAt: schema.questionSets.submittedAt,
        subjectId: schema.questionSets.subjectId,
        levelId: schema.questionSets.levelId,
        departmentId: schema.questionSets.departmentId,
        seriesId: schema.questionSets.seriesId,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
        teacherFirst: schema.staff.firstName,
        teacherLast: schema.staff.lastName,
        seriesTitle: schema.examSeries.title,
        seriesType: schema.examSeries.seriesType,
        questionCount: sql<number>`(
          SELECT count(*) FROM ${schema.questions} q
          WHERE q.question_set_id = ${schema.questionSets.id} AND q.status = 'active'
        )`.mapWith(Number),
      })
      .from(schema.questionSets)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionSets.subjectId))
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.questionSets.levelId))
      .leftJoin(schema.staff, eq(schema.staff.id, schema.questionSets.teacherId))
      .leftJoin(schema.examSeries, eq(schema.examSeries.id, schema.questionSets.seriesId))
      .where(eq(schema.questionSets.schoolId, actor.schoolId))
      .orderBy(sql`${schema.questionSets.submittedAt} desc nulls last`);

    // One row per paper: objective and theory of the same scope belong
    // together, the way the teacher who wrote them and the office reviewing
    // them both think of a single subject's submission.
    const byScope = new Map<string, {
      key: string; subjectName: string; levelName: string; teacherFirst: string | null; teacherLast: string | null;
      deliveryMode: string; waecMode: boolean; seriesType: string; seriesTitle: string; submittedAt: Date | null;
      objective: { setId: number; count: number; min: number; status: string } | null;
      theory: { setId: number; count: number; min: number; status: string } | null;
    }>();

    for (const r of rows) {
      const seriesType = r.seriesId === 0 ? 'examination' : (r.seriesType ?? 'ca_test');
      const key = `${r.subjectId}:${r.levelId}:${r.departmentId ?? ''}:${r.seriesId}:${r.waecMode}`;
      let entry = byScope.get(key);

      if (!entry) {
        entry = {
          key, subjectName: r.subjectName, levelName: r.levelName,
          teacherFirst: r.teacherFirst, teacherLast: r.teacherLast,
          deliveryMode: r.deliveryMode, waecMode: r.waecMode, seriesType,
          seriesTitle: r.seriesId === 0 ? 'Terminal examination' : (r.seriesTitle ?? 'Deleted collection'),
          submittedAt: r.submittedAt, objective: null, theory: null,
        };
        byScope.set(key, entry);
      }

      const half = { setId: Number(r.id), count: r.questionCount, min: r.minRequired, status: r.status };
      if (r.examType === 'objective') entry.objective = half; else entry.theory = half;
      if (r.submittedAt && (!entry.submittedAt || r.submittedAt > entry.submittedAt)) entry.submittedAt = r.submittedAt;
      // Prefer whichever teacher submitted the paper over whoever merely opened it first.
      if (r.status !== 'draft') { entry.teacherFirst = r.teacherFirst; entry.teacherLast = r.teacherLast; }
    }

    return [...byScope.values()].sort((a, b) => {
      const at = a.submittedAt?.getTime() ?? 0;
      const bt = b.submittedAt?.getTime() ?? 0;
      return bt - at;
    });
  });
}

/**
 * Delete a question set outright — the office's cleanup action for a
 * duplicate or abandoned submission. The vault snapshot (if any) is left in
 * place; it is keyed to the set id and harmless once orphaned, and restoring
 * a deleted set back into existence is exactly what "Restore missing
 * questions" is for if this turns out to be a mistake.
 */
export async function deleteSet(actor: Actor, setId: number) {
  if (!isSchoolWide(actor.role)) throw new Error('Only the exam office can delete a submission.');

  return forSchool(actor.schoolId, async (tx) => {
    const [set] = await tx.select({ id: schema.questionSets.id, status: schema.questionSets.status })
      .from(schema.questionSets)
      .where(and(eq(schema.questionSets.id, setId), eq(schema.questionSets.schoolId, actor.schoolId)));

    if (!set) throw new Error('Question set not found.');

    await tx.delete(schema.questionSets).where(eq(schema.questionSets.id, setId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'question_set.deleted', entityType: 'question_sets', entityId: setId,
      before: { status: set.status },
    });
  });
}

/** One set with its active questions, for the inline entry area on /portal/questions. */
export async function setWithQuestions(actor: Actor, setId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    const [set] = await tx.select().from(schema.questionSets)
      .where(and(eq(schema.questionSets.id, setId), eq(schema.questionSets.schoolId, actor.schoolId))).limit(1);
    if (!set) return null;
    if (!isSchoolWide(actor.role) && (!actor.staffId || set.teacherId !== actor.staffId)) return null;

    const questions = await tx.select({
      id: schema.questions.id, text: schema.questions.questionText, marks: schema.questions.marks,
      sequence: schema.questions.sequence, approvalStatus: schema.questions.approvalStatus,
      reviewerComment: schema.questions.reviewerComment,
    }).from(schema.questions)
      .where(and(eq(schema.questions.questionSetId, setId), eq(schema.questions.status, 'active')))
      .orderBy(asc(schema.questions.sequence));

    return { set, questions };
  });
}
