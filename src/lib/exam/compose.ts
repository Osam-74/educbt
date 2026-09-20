/**
 * Turning approved question sets into papers a candidate can sit.
 *
 * Composition is where an examination stops being a pile of questions and
 * becomes a schedule. Three rules, each learned the hard way:
 *
 *   1. ONLY APPROVED SETS COMPOSE. A draft in the pool means a paper containing
 *      questions nobody reviewed.
 *
 *   2. A PAPER SHORT OF QUESTIONS IS NOT COMPOSED. Silently shortening it gives
 *      one class twelve questions and another twenty, both marked out of the
 *      same total. The subject is named and skipped instead.
 *
 *   3. RE-COMPOSING DOES NOT DUPLICATE. Running it twice is something a school
 *      office will do, so it has to be safe.
 *
 * The Exam Office UI (src/app/portal/exams) drives every function here. The
 * services remain the only place the rules live — the pages present their
 * results, never re-decide them.
 */

import { and, eq, sql, asc } from 'drizzle-orm';
import { z } from 'zod';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { caComponents } from '@/lib/ca/validation';

export type ComposeResult = {
  created: number;
  skipped: number;
  short: string[];
};

// ── Series creation ──────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const createSeriesInput = z.object({
  title: z.string().trim().min(3, 'Give the examination a name of at least 3 characters.')
    .max(191),
  seriesType: z.enum(['examination', 'ca_test', 'practice']),
  sessionId: z.coerce.number().int().positive(),
  termId: z.coerce.number().int().positive(),
  questionsPerStudent: z.coerce.number().int().min(1).max(200),
  durationMinutes: z.coerce.number().int().min(5).max(300),
  // The window in which TEACHERS submit questions. Not the sitting dates.
  questionsOpenFrom: z.string().regex(ISO_DATE).optional().nullable(),
  questionsOpenTo: z.string().regex(ISO_DATE).optional().nullable(),
  // Which CA slot (schools.settings.assessmentComponents[].key) this test
  // counts towards — meaningful only for seriesType 'ca_test'. Validated
  // against the school's own configured slots below, not trusted as-is.
  caComponentKey: z.string().trim().min(1).max(64).optional().nullable(),
  // 'cbt' or 'written' forces every subject in this series; 'mixed' lets each
  // subject-teacher choose in the Question Bank (see submitSet in sets.ts for
  // what 'mixed' changes about a written declaration).
  assessmentMode: z.enum(['cbt', 'written', 'mixed']).default('mixed'),
}).refine(
  (v) => !v.questionsOpenFrom || !v.questionsOpenTo
    || new Date(v.questionsOpenFrom) < new Date(v.questionsOpenTo),
  { message: 'The question submission window must open before it closes.' },
);

export type CreateSeriesInput = z.infer<typeof createSeriesInput>;

/**
 * Create an exam series.
 *
 * The series starts as a draft: teachers write into it (or into the terminal
 * bank, for a formal examination), the office composes papers from approved
 * sets, and only then does it become a schedule.
 */
export async function createSeries(actor: Actor, input: unknown) {
  const parsed = createSeriesInput.safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'The examination details are not valid.');
  }
  const data = parsed.data;

  return forSchool(actor.schoolId, async (tx) => {
    const [session] = await tx.select({ id: schema.academicSessions.id })
      .from(schema.academicSessions)
      .where(and(
        eq(schema.academicSessions.id, data.sessionId),
        eq(schema.academicSessions.schoolId, actor.schoolId),
      )).limit(1);

    if (!session) throw new Error('That academic session does not exist in this school.');

    const [term] = await tx.select({ id: schema.terms.id })
      .from(schema.terms)
      .where(and(
        eq(schema.terms.id, data.termId),
        eq(schema.terms.schoolId, actor.schoolId),
      )).limit(1);

    if (!term) throw new Error('That term does not exist in this school.');

    // A CA slot only makes sense on a CA test, and only one of the school's
    // own configured slots — never a value invented by the client.
    let caComponentKey: string | null = null;
    if (data.caComponentKey) {
      if (data.seriesType !== 'ca_test') {
        throw new Error('A CA slot only applies to a CA test.');
      }
      const [school] = await tx.select({ settings: schema.schools.settings })
        .from(schema.schools)
        .where(eq(schema.schools.id, actor.schoolId)).limit(1);
      const slots = caComponents((school?.settings ?? {}) as Record<string, unknown>);
      if (!slots.some((c) => c.key === data.caComponentKey)) {
        throw new Error('That CA slot is not configured in School Settings.');
      }
      caComponentKey = data.caComponentKey;
    }

    const [series] = await tx.insert(schema.examSeries).values({
      schoolId: actor.schoolId,
      sessionId: data.sessionId,
      termId: data.termId,
      title: data.title,
      seriesType: data.seriesType,
      caComponentKey,
      questionsPerStudent: data.questionsPerStudent,
      durationMinutes: data.durationMinutes,
      questionsOpenFrom: asDate(data.questionsOpenFrom ?? null),
      questionsOpenTo: asDate(data.questionsOpenTo ?? null),
      status: 'draft',
      assessmentMode: data.assessmentMode,
      createdBy: actor.userId,
    }).returning();

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam_series.created',
      entityType: 'exam_series',
      entityId: Number(series!.id),
      after: {
        title: data.title,
        seriesType: data.seriesType,
        caComponentKey,
        assessmentMode: data.assessmentMode,
        questionsPerStudent: data.questionsPerStudent,
        durationMinutes: data.durationMinutes,
      },
    });

    return series!;
  });
}

// ── Question availability ────────────────────────────────────────────────────

type PoolCandidate = {
  setId: number;
  subjectId: number;
  levelId: number;
  departmentId: number | null;
  subjectName: string;
  levelName: string;
  available: number;
  deliveryMode: string;
};

/**
 * The candidate pools for a series — the ONE query that decides what can be
 * composed. Composition and the availability report both use it, so the two
 * can never disagree about what counts as available.
 */
async function poolCandidates(
  tx: Tx,
  schoolId: number,
  seriesType: 'examination' | 'ca_test' | 'practice',
  seriesId: number,
): Promise<PoolCandidate[]> {
  return tx
    .select({
      setId: schema.questionSets.id,
      subjectId: schema.questionSets.subjectId,
      levelId: schema.questionSets.levelId,
      departmentId: schema.questionSets.departmentId,
      subjectName: schema.subjects.name,
      levelName: schema.classLevels.name,
      deliveryMode: schema.questionSets.deliveryMode,
      available: sql<number>`(
        SELECT count(*) FROM ${schema.questions} q
        WHERE q.question_set_id = ${schema.questionSets.id}
          AND q.status = 'active'
          AND q.approval_status = 'approved'
      )`.mapWith(Number),
    })
    .from(schema.questionSets)
    .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionSets.subjectId))
    .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.questionSets.levelId))
    .where(and(
      eq(schema.questionSets.schoolId, schoolId),
      eq(schema.questionSets.status, 'approved'),
      eq(schema.questionSets.examType, 'objective'),
      // A formal examination draws from the terminal bank (series 0); a CA test
      // or practice paper only from sets written into its own series.
      seriesType === 'examination'
        ? eq(schema.questionSets.seriesId, 0)
        : eq(schema.questionSets.seriesId, seriesId),
    ));
}

/**
 * What the office needs to see BEFORE composing: for every subject and level,
 * how many questions the paper requires and how many approved questions exist.
 *
 * Purely a report — it runs the exact query composition will run, so what it
 * says is what composition does.
 */
export async function questionAvailability(actor: Actor, seriesId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      )).limit(1);

    if (!series) throw new Error('Examination not found.');

    const perStudent = series.questionsPerStudent > 0 ? series.questionsPerStudent : 20;

    const pools = await poolCandidates(
      tx, actor.schoolId, series.seriesType, seriesId,
    );

    const papers = await tx.select({
      subjectId: schema.examPapers.subjectId,
      levelId: schema.examPapers.levelId,
    })
      .from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.seriesId, seriesId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ));

    const composed = new Set(papers.map((p) => `${p.subjectId}#${p.levelId}`));

    return {
      perStudent,
      durationMinutes: series.durationMinutes,
      rows: pools.map((p) => ({
        setId: p.setId,
        subjectName: p.subjectName,
        levelName: p.levelName,
        required: perStudent,
        available: p.available,
        ready: p.available >= perStudent,
        alreadyComposed: composed.has(`${p.subjectId}#${p.levelId}`),
      })),
    };
  });
}

// ── Composition ──────────────────────────────────────────────────────────────

export async function composeSeries(
  actor: Actor,
  seriesId: number,
  opts: { questionsPerStudent?: number; durationMinutes?: number } = {},
): Promise<ComposeResult> {
  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      )).limit(1);

    if (!series) throw new Error('Examination not found.');

    const perStudent = opts.questionsPerStudent
      ?? (series.questionsPerStudent > 0 ? series.questionsPerStudent : 20);

    const duration = (opts.durationMinutes
      ?? (series.durationMinutes > 0 ? series.durationMinutes : 60)) * 60;

    const candidates = await poolCandidates(
      tx, actor.schoolId, series.seriesType, seriesId,
    );

    let created = 0;
    let skipped = 0;
    const short: string[] = [];

    for (const c of candidates) {
      // Written delivery has nothing to pool — there is no bank of typed
      // questions, only the teacher's intent (see WrittenIntent.tsx). It
      // still needs a paper: the exam office schedules it, invigilates it,
      // and later enters its mark by hand (lib/ca/queries.ts caFullSheet) —
      // none of which can happen if it never gets composed for want of
      // questions it was never going to have.
      if (c.deliveryMode !== 'written' && c.available < perStudent) {
        skipped++;
        short.push(`${c.subjectName} ${c.levelName} (${c.available} of ${perStudent})`);
        continue;
      }

      // Already composed. Re-composing is something an office does, so it must
      // not produce a second paper for the same subject and level — UNLESS the
      // paper is an empty placeholder created ahead of time (see
      // composeFromAssignments below), in which case this is exactly the moment
      // it gets its actual questions.
      const [existing] = await tx.select({ id: schema.examPapers.id })
        .from(schema.examPapers)
        .where(and(
          eq(schema.examPapers.seriesId, seriesId),
          eq(schema.examPapers.subjectId, c.subjectId),
          eq(schema.examPapers.levelId, c.levelId),
        )).limit(1);

      if (existing) {
        // A written paper has nothing to fill in later — its existence alone
        // means it is done, unlike a CBT placeholder which is deliberately
        // left to be filled the moment questions become available.
        if (c.deliveryMode === 'written') { skipped++; continue; }
        const existingRows = await tx.select({ existingCount: sql<number>`count(*)`.mapWith(Number) })
          .from(schema.paperQuestions)
          .where(eq(schema.paperQuestions.paperId, Number(existing.id)));
        if ((existingRows[0]?.existingCount ?? 0) > 0) { skipped++; continue; }
      }

      let paperId: number;
      if (existing) {
        paperId = Number(existing.id);
        await tx.update(schema.examPapers)
          .set({ durationSeconds: duration, questionCount: perStudent })
          .where(eq(schema.examPapers.id, paperId));
      } else {
        // A representative class, for display. The paper belongs to the level.
        const [representative] = await tx.select({ id: schema.classes.id })
          .from(schema.classes)
          .where(and(
            eq(schema.classes.schoolId, actor.schoolId),
            eq(schema.classes.levelId, c.levelId),
            eq(schema.classes.status, 'active'),
          ))
          .orderBy(asc(schema.classes.arm))
          .limit(1);

        const [paper] = await tx.insert(schema.examPapers).values({
          schoolId: actor.schoolId,
          seriesId,
          subjectId: c.subjectId,
          levelId: c.levelId,
          departmentId: c.departmentId,
          classId: representative?.id ?? null,
          durationSeconds: duration,
          questionCount: perStudent,
          status: 'draft',
        }).returning();
        paperId = Number(paper!.id);
      }

      const pool = await tx.select({ id: schema.questions.id })
        .from(schema.questions)
        .where(and(
          eq(schema.questions.questionSetId, c.setId),
          eq(schema.questions.status, 'active'),
          eq(schema.questions.approvalStatus, 'approved'),
        ))
        .orderBy(asc(schema.questions.sequence));

      if (pool.length > 0) {
        await tx.insert(schema.paperQuestions).values(
          pool.map((q, i) => ({
            schoolId: actor.schoolId,
            paperId,
            questionId: Number(q.id),
            sortOrder: i,
          })),
        );
      }

      // Denormalized onto the paper so scheduling, invigilation and results
      // can all tell a written sitting from a CBT one without re-joining
      // back to the question set every time.
      await tx.update(schema.examPapers).set({ deliveryMode: c.deliveryMode === 'written' ? 'written' : 'cbt' })
        .where(eq(schema.examPapers.id, paperId));

      created++;
    }

    if (created > 0) {
      await tx.update(schema.examSeries)
        .set({ status: 'composed' })
        .where(eq(schema.examSeries.id, seriesId));
    }

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam_series.composed',
      entityType: 'exam_series',
      entityId: seriesId,
      after: { created, skipped, short },
    });

    return { created, skipped, short };
  });
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Lay the papers out across a sitting window.
 *
 * The window is set HERE, not when the series was created — the dates on a
 * series are the question-submission window, and the school does not know the
 * sitting dates until it has papers to schedule.
 *
 * The first and last days of sitting are stored on the series, because
 * `startAttempt` enforces them: a formal paper cannot be started before the
 * window opens or after it closes. Practice series are never scheduled — they
 * are always available.
 */
export async function scheduleSeries(
  actor: Actor,
  seriesId: number,
  startsOn: string,
  endsOn: string | null,
  slotsPerDay = 2,
): Promise<{ scheduled: number; unplaced: string[] }> {
  if (!ISO_DATE.test(startsOn) || (endsOn && !ISO_DATE.test(endsOn))) {
    throw new Error('The sitting dates must be real dates.');
  }

  const slots = Math.min(Math.max(Math.trunc(slotsPerDay) || 2, 1), 4);

  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      )).limit(1);

    if (!series) throw new Error('Examination not found.');

    if (series.seriesType === 'practice') {
      throw new Error('A practice examination is always available. It is not scheduled.');
    }

    const papers = await tx
      .select({
        id: schema.examPapers.id,
        levelId: schema.examPapers.levelId,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
      })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
      .where(and(
        eq(schema.examPapers.seriesId, seriesId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .orderBy(asc(schema.examPapers.levelId), asc(schema.subjects.name));

    if (papers.length === 0) {
      throw new Error('There are no papers to schedule. Compose papers first.');
    }

    const days = weekdaysBetween(startsOn, endsOn, 10);

    if (days.length === 0) {
      throw new Error('The last day of sitting falls before the first.');
    }

    // slot -> levels already sitting in it
    const taken = new Map<string, Set<number>>();
    const unplaced: string[] = [];
    let scheduled = 0;

    for (const paper of papers) {
      let placed = false;

      for (const day of days) {
        for (let slot = 0; slot < slots; slot++) {
          const key = `${day}#${slot}`;
          const levels = taken.get(key) ?? new Set<number>();
          const levelId = Number(paper.levelId ?? 0);

          // One class cannot sit two papers at once.
          if (levels.has(levelId)) continue;

          const at = new Date(`${day}T${slot === 0 ? '09' : '13'}:00:00Z`);

          await tx.update(schema.examPapers)
            .set({ scheduledAt: at })
            .where(eq(schema.examPapers.id, Number(paper.id)));

          levels.add(levelId);
          taken.set(key, levels);
          scheduled++;
          placed = true;
          break;
        }

        if (placed) break;
      }

      // Named rather than silently dropped. A paper with no slot is a paper
      // nobody sits, and the office needs to know which.
      if (!placed) unplaced.push(`${paper.subjectName} ${paper.levelName ?? ''}`.trim());
    }

    // The sitting window the engine will enforce. The first sitting day opens
    // at midnight and the last closes at the end of the day — the slots within
    // it are the timetable's business, the window is the gate.
    const first = days[0]!;
    const last = days[days.length - 1]!;
    const opensAt = new Date(`${first}T00:00:00Z`);
    const closesAt = new Date(`${last}T23:59:59Z`);

    await tx.update(schema.examSeries)
      .set({ sittingOpensAt: opensAt, sittingClosesAt: closesAt })
      .where(eq(schema.examSeries.id, seriesId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam_series.scheduled',
      entityType: 'exam_series',
      entityId: seriesId,
      after: {
        scheduled,
        unplaced,
        startsOn: first,
        endsOn: last,
        slotsPerDay: slots,
      },
    });

    return { scheduled, unplaced };
  });
}

/**
 * Every paper in a series, with its slot — the timetable the office reviews
 * before publishing.
 */
export async function seriesPapers(actor: Actor, seriesId: number) {
  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      )).limit(1);

    if (!series) throw new Error('Examination not found.');

    const papers = await tx
      .select({
        id: schema.examPapers.id,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
        scheduledAt: schema.examPapers.scheduledAt,
        durationSeconds: schema.examPapers.durationSeconds,
        questionCount: schema.examPapers.questionCount,
        status: schema.examPapers.status,
      })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
      .where(and(
        eq(schema.examPapers.seriesId, seriesId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ))
      .orderBy(asc(schema.examPapers.scheduledAt), asc(schema.subjects.name));

    return { series, papers };
  });
}

// ── Publishing ────────────────────────────────────────────────────────────────

/**
 * Publish every composed paper, making them sittable.
 *
 * Readiness is enforced HERE, not in the page: a formal examination cannot be
 * published with unscheduled papers or without a sitting window, and nothing
 * can be published with no papers at all. A page can lie; the service cannot.
 */
export async function publishSeries(actor: Actor, seriesId: number): Promise<number> {
  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      )).limit(1);

    if (!series) throw new Error('Examination not found.');

    const papers = await tx.select({
      id: schema.examPapers.id,
      scheduledAt: schema.examPapers.scheduledAt,
      status: schema.examPapers.status,
      subjectName: schema.subjects.name,
      levelName: schema.classLevels.name,
    })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
      .where(and(
        eq(schema.examPapers.seriesId, seriesId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      ));

    if (papers.length === 0) {
      throw new Error('There are no papers to publish. Compose papers first.');
    }

    // Practice papers are always available; every other kind sits to a timetable.
    if (series.seriesType !== 'practice') {
      const unscheduled = papers.filter((p) => !p.scheduledAt);

      if (unscheduled.length > 0 || !series.sittingOpensAt || !series.sittingClosesAt) {
        const names = unscheduled
          .map((p) => `${p.subjectName} ${p.levelName ?? ''}`.trim())
          .join(', ');

        throw new Error(
          `This examination is not ready to publish. ${unscheduled.length} paper(s) ` +
          `have no timetable slot${names ? `: ${names}` : ''}. Schedule the examination first.`,
        );
      }
    }

    const result = await tx.update(schema.examPapers)
      .set({ status: 'published' })
      .where(and(
        eq(schema.examPapers.seriesId, seriesId),
        eq(schema.examPapers.schoolId, actor.schoolId),
        eq(schema.examPapers.status, 'draft'),
      ))
      .returning({ id: schema.examPapers.id });

    if (result.length === 0 && series.status === 'published') {
      throw new Error('This examination is already published.');
    }

    await tx.update(schema.examSeries)
      .set({ status: 'published' })
      .where(eq(schema.examSeries.id, seriesId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam_series.published',
      entityType: 'exam_series',
      entityId: seriesId,
      after: { papers: result.length },
    });

    return result.length;
  });
}

/**
 * Delete a series that never went anywhere — the office started the wrong
 * thing, or a practice/CA test nobody ended up using.
 *
 * Deliberately narrow: only a DRAFT series (never composed, never published)
 * can go. Once papers are composed a candidate could plausibly have already
 * relied on the question submission window it opened, and once published
 * there may be scores or attempts against it — deleting either silently
 * destroys data the office cannot see is at risk. Those series are closed or
 * cancelled through their own lifecycle, never deleted.
 */
export async function deleteSeries(actor: Actor, seriesId: number): Promise<void> {
  return forSchool(actor.schoolId, async (tx) => {
    const [series] = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.id, seriesId),
        eq(schema.examSeries.schoolId, actor.schoolId),
      )).limit(1);

    if (!series) throw new Error('Examination not found.');
    if (series.status !== 'draft') {
      throw new Error('Only an examination still being prepared (no papers composed yet) can be deleted.');
    }

    await tx.delete(schema.examSeries).where(eq(schema.examSeries.id, seriesId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam_series.deleted',
      entityType: 'exam_series',
      entityId: seriesId,
      before: { title: series.title, seriesType: series.seriesType },
    });
  });
}

// ── Per-paper overview ───────────────────────────────────────────────────────

export type PaperOverviewRow = {
  key: string;
  seriesId: number;
  seriesTitle: string;
  seriesType: string;
  paperId: number | null;
  subjectName: string;
  levelName: string | null;
  deliveryMode: string;
  scheduledAt: Date | null;
  durationSeconds: number | null;
  questionCount: number;
  invigilatorName: string | null;
  status: 'not_composed' | 'draft' | 'published';
};

/**
 * Every paper the office needs to see in one flat list — across every formal
 * examination and CA test (practice is excluded; it has no timetable and is
 * always available once published). One row per subject/class combination:
 * already composed (with its schedule, invigilator and status) or still a
 * candidate waiting to be composed. This is what "Papers" on the Exam Papers
 * page shows — the plugin's own view (templates/portal/exams/papers.php):
 * papers come from the timetable, and from here the office composes, publishes,
 * or deletes one.
 */
export async function paperOverview(actor: Actor): Promise<PaperOverviewRow[]> {
  return forSchool(actor.schoolId, async (tx) => {
    const seriesRows = await tx.select().from(schema.examSeries)
      .where(and(
        eq(schema.examSeries.schoolId, actor.schoolId),
        sql`${schema.examSeries.seriesType} <> 'practice'`,
      ))
      .orderBy(asc(schema.examSeries.id));

    const out: PaperOverviewRow[] = [];

    for (const series of seriesRows) {
      const candidates = await poolCandidates(
        tx, actor.schoolId, series.seriesType as 'examination' | 'ca_test', series.id,
      );

      const papers = await tx.select({
        id: schema.examPapers.id,
        subjectId: schema.examPapers.subjectId,
        levelId: schema.examPapers.levelId,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
        scheduledAt: schema.examPapers.scheduledAt,
        durationSeconds: schema.examPapers.durationSeconds,
        questionCount: schema.examPapers.questionCount,
        status: schema.examPapers.status,
        invigilatorFirst: schema.staff.firstName,
        invigilatorLast: schema.staff.lastName,
      })
        .from(schema.examPapers)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
        .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.examPapers.levelId))
        .leftJoin(schema.staff, eq(schema.staff.id, schema.examPapers.invigilatorStaffId))
        .where(and(
          eq(schema.examPapers.seriesId, series.id),
          eq(schema.examPapers.schoolId, actor.schoolId),
        ))
        .orderBy(asc(schema.examPapers.scheduledAt), asc(schema.subjects.name));

      const composedKeys = new Set(papers.map((p) => `${p.subjectId}#${p.levelId}`));

      for (const p of papers) {
        const cand = candidates.find((c) => c.subjectId === p.subjectId && c.levelId === p.levelId);
        out.push({
          key: `paper-${p.id}`,
          seriesId: series.id,
          seriesTitle: series.title,
          seriesType: series.seriesType,
          paperId: Number(p.id),
          subjectName: p.subjectName,
          levelName: p.levelName,
          deliveryMode: cand?.deliveryMode ?? 'cbt',
          scheduledAt: p.scheduledAt,
          durationSeconds: p.durationSeconds,
          questionCount: p.questionCount,
          invigilatorName: p.invigilatorFirst ? `${p.invigilatorFirst} ${p.invigilatorLast ?? ''}`.trim() : null,
          status: p.status === 'published' ? 'published' : 'draft',
        });
      }

      for (const c of candidates) {
        if (composedKeys.has(`${c.subjectId}#${c.levelId}`)) continue;
        out.push({
          key: `candidate-${series.id}-${c.setId}`,
          seriesId: series.id,
          seriesTitle: series.title,
          seriesType: series.seriesType,
          paperId: null,
          subjectName: c.subjectName,
          levelName: c.levelName,
          deliveryMode: c.deliveryMode,
          scheduledAt: null,
          durationSeconds: null,
          questionCount: 0,
          invigilatorName: null,
          status: 'not_composed',
        });
      }
    }

    return out;
  });
}

/**
 * Delete a single paper — the office composed the wrong thing, or a subject
 * was dropped after the fact. Only a paper still in draft (never published)
 * can go; once published a candidate may already be relying on it, and that
 * is undone by unpublishing the examination, not by deleting the paper out
 * from under a live schedule.
 */
export async function deletePaper(actor: Actor, paperId: number): Promise<void> {
  return forSchool(actor.schoolId, async (tx) => {
    const [paper] = await tx.select().from(schema.examPapers)
      .where(and(
        eq(schema.examPapers.id, paperId),
        eq(schema.examPapers.schoolId, actor.schoolId),
      )).limit(1);

    if (!paper) throw new Error('Paper not found.');
    if (paper.status !== 'draft') {
      throw new Error('Only a draft paper can be deleted. A published paper is removed by unpublishing the examination first.');
    }

    await tx.delete(schema.examPapers).where(eq(schema.examPapers.id, paperId));

    await tx.insert(schema.auditLog).values({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'exam_paper.deleted',
      entityType: 'exam_paper',
      entityId: paperId,
      before: { subjectId: paper.subjectId, levelId: paper.levelId, seriesId: paper.seriesId },
    });
  });
}

// ── Listing ──────────────────────────────────────────────────────────────────

export async function listSeries(actor: Actor) {
  return forSchool(actor.schoolId, async (tx) =>
    tx.select({
      id: schema.examSeries.id,
      title: schema.examSeries.title,
      seriesType: schema.examSeries.seriesType,
      caComponentKey: schema.examSeries.caComponentKey,
      status: schema.examSeries.status,
      createdAt: schema.examSeries.createdAt,
      sessionId: schema.examSeries.sessionId,
      termId: schema.examSeries.termId,
      questionsOpenFrom: schema.examSeries.questionsOpenFrom,
      questionsOpenTo: schema.examSeries.questionsOpenTo,
      sittingOpensAt: schema.examSeries.sittingOpensAt,
      sittingClosesAt: schema.examSeries.sittingClosesAt,
      paperCount: sql<number>`(
        SELECT count(*) FROM ${schema.examPapers} p WHERE p.series_id = ${schema.examSeries.id}
      )`.mapWith(Number),
      unscheduledCount: sql<number>`(
        SELECT count(*) FROM ${schema.examPapers} p
        WHERE p.series_id = ${schema.examSeries.id} AND p.scheduled_at IS NULL
      )`.mapWith(Number),
    })
      .from(schema.examSeries)
      .where(eq(schema.examSeries.schoolId, actor.schoolId))
      .orderBy(sql`${schema.examSeries.id} DESC`),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function weekdaysBetween(startsOn: string, endsOn: string | null, cap: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startsOn}T00:00:00Z`);
  const last = endsOn ? new Date(`${endsOn}T00:00:00Z`) : null;

  while (out.length < cap) {
    // Weekends are not sitting days.
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
      if (last && cursor > last) break;
      out.push(cursor.toISOString().slice(0, 10));
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);

    if (last && cursor > last && out.length > 0) break;
    if (!last && out.length >= cap) break;
  }

  return out;
}
