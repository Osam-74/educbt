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
 */

import { and, eq, inArray, sql, asc, count } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';

export type ComposeResult = {
  created: number;
  skipped: number;
  short: string[];
};

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

    // Only approved sets. A set still in draft is a set nobody has read.
    const candidates = await tx
      .select({
        setId: schema.questionSets.id,
        subjectId: schema.questionSets.subjectId,
        levelId: schema.questionSets.levelId,
        departmentId: schema.questionSets.departmentId,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
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
        eq(schema.questionSets.schoolId, actor.schoolId),
        eq(schema.questionSets.status, 'approved'),
        eq(schema.questionSets.examType, 'objective'),
        series.seriesType === 'examination'
          ? eq(schema.questionSets.seriesId, 0)
          : eq(schema.questionSets.seriesId, seriesId),
      ));

    let created = 0;
    let skipped = 0;
    const short: string[] = [];

    for (const c of candidates) {
      if (c.available < perStudent) {
        skipped++;
        short.push(`${c.subjectName} ${c.levelName} (${c.available} of ${perStudent})`);
        continue;
      }

      // Already composed. Re-composing is something an office does, so it must
      // not produce a second paper for the same subject and level.
      const [existing] = await tx.select({ id: schema.examPapers.id })
        .from(schema.examPapers)
        .where(and(
          eq(schema.examPapers.seriesId, seriesId),
          eq(schema.examPapers.subjectId, c.subjectId),
          eq(schema.examPapers.levelId, c.levelId),
        )).limit(1);

      if (existing) { skipped++; continue; }

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

      const pool = await tx.select({ id: schema.questions.id })
        .from(schema.questions)
        .where(and(
          eq(schema.questions.questionSetId, c.setId),
          eq(schema.questions.status, 'active'),
          eq(schema.questions.approvalStatus, 'approved'),
        ))
        .orderBy(asc(schema.questions.sequence));

      await tx.insert(schema.paperQuestions).values(
        pool.map((q, i) => ({
          schoolId: actor.schoolId,
          paperId: Number(paper!.id),
          questionId: Number(q.id),
          sortOrder: i,
        })),
      );

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

/**
 * Lay the papers out across a sitting window.
 *
 * The window is set HERE, not when the series was created — the dates on a
 * series are the question-submission window, and the school does not know the
 * sitting dates until it has papers to schedule.
 *
 * Papers for different levels may share a slot; papers for the same level may
 * not, because one class cannot sit two subjects at once.
 */
export async function scheduleSeries(
  actor: Actor,
  seriesId: number,
  startsOn: string,
  endsOn: string | null,
  slotsPerDay = 2,
): Promise<{ scheduled: number; unplaced: string[] }> {
  return forSchool(actor.schoolId, async (tx) => {
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
        for (let slot = 0; slot < slotsPerDay; slot++) {
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

    return { scheduled, unplaced };
  });
}

/** Publish every composed paper, making them sittable. */
export async function publishSeries(actor: Actor, seriesId: number): Promise<number> {
  return forSchool(actor.schoolId, async (tx) => {
    const result = await tx.update(schema.examPapers)
      .set({ status: 'published' })
      .where(and(
        eq(schema.examPapers.seriesId, seriesId),
        eq(schema.examPapers.schoolId, actor.schoolId),
        eq(schema.examPapers.status, 'draft'),
      ))
      .returning({ id: schema.examPapers.id });

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

export async function listSeries(actor: Actor) {
  return forSchool(actor.schoolId, async (tx) =>
    tx.select({
      id: schema.examSeries.id,
      title: schema.examSeries.title,
      seriesType: schema.examSeries.seriesType,
      status: schema.examSeries.status,
      paperCount: sql<number>`(
        SELECT count(*) FROM ${schema.examPapers} p WHERE p.series_id = ${schema.examSeries.id}
      )`.mapWith(Number),
    })
      .from(schema.examSeries)
      .where(eq(schema.examSeries.schoolId, actor.schoolId))
      .orderBy(sql`${schema.examSeries.id} DESC`),
  );
}

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
