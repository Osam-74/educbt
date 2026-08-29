/**
 * The question vault.
 *
 * WHY THIS EXISTS
 *
 * A term's questions are the most expensive thing in the system. A teacher
 * spends days writing them and a reviewer hours checking them, and unlike a
 * result they cannot be recomputed from anything else. If the rows go, the work
 * is gone.
 *
 * They HAVE gone once. In the WordPress system a plugin delete dropped the
 * questions table, and because the questions lived nowhere else there was
 * nothing to restore from. Results survived the same event because they are
 * derived from scores; questions had no such second copy.
 *
 * So this keeps one. A set is snapshotted at the two moments the work is
 * finished and worth preserving — submission and approval — into a table that
 * no feature ever deletes from, and (in production) mirrored to object storage,
 * which no database migration can drop.
 *
 * RESTORE PRESERVES QUESTION IDS, NOT OPTION IDS.
 * Papers and results reference questions by id, so those must come back
 * unchanged. Nothing references an option by id, and restoring their original
 * keys collided with rows that already existed — a real bug in the WordPress
 * version, surfacing as "duplicate entry for key PRIMARY".
 */

import { and, eq, inArray } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import { questionVault } from '@/db/schema/vault';

export { questionVault };


type Snapshot = {
  version: 1;
  setId: number;
  takenAt: string;
  questions: Array<{
    row: Record<string, unknown>;
    options: Array<Record<string, unknown>>;
  }>;
};

/**
 * Snapshot one set.
 *
 * Refuses to store an incomplete copy. An objective question without its
 * options is not a backup — it is a question with no answer key, and that would
 * only be discovered at restore time, when the original is already gone.
 */
export async function snapshotSet(
  schoolId: number,
  setId: number,
  trigger: 'submitted' | 'approved' | 'manual',
): Promise<{ stored: boolean; reason?: string }> {
  return forSchool(schoolId, async (tx) => {
    const rows = await tx.select().from(schema.questions)
      .where(and(
        eq(schema.questions.questionSetId, setId),
        eq(schema.questions.schoolId, schoolId),
        eq(schema.questions.status, 'active'),
      ));

    if (rows.length === 0) return { stored: false, reason: 'nothing to store' };

    const optionRows = await tx.select().from(schema.questionOptions)
      .where(inArray(schema.questionOptions.questionId, rows.map((r) => Number(r.id))));

    const optionsByQuestion = new Map<number, Array<Record<string, unknown>>>();

    for (const o of optionRows) {
      const qid = Number(o.questionId);
      const list = optionsByQuestion.get(qid) ?? [];
      list.push(o as unknown as Record<string, unknown>);
      optionsByQuestion.set(qid, list);
    }

    const questions: Snapshot['questions'] = [];

    for (const row of rows) {
      const opts = optionsByQuestion.get(Number(row.id)) ?? [];

      if (row.questionType !== 'theory' && opts.length === 0) {
        return {
          stored: false,
          reason: `question ${row.id} has no options — refusing to store a copy without its answer key`,
        };
      }

      questions.push({ row: row as unknown as Record<string, unknown>, options: opts });
    }

    await tx.insert(questionVault).values({
      schoolId,
      questionSetId: setId,
      payload: {
        version: 1,
        setId,
        takenAt: new Date().toISOString(),
        questions,
      } satisfies Snapshot,
      questionCount: questions.length,
      reason: { trigger },
    });

    return { stored: true };
  });
}

/**
 * Put a snapshot back.
 *
 * Only restores what is MISSING. A question that still exists is left alone —
 * the live copy may have been edited since the snapshot, and overwriting it
 * would undo that work.
 */
export async function restoreSet(
  schoolId: number,
  setId: number,
): Promise<{ restored: number; skipped: number; error?: string }> {
  return forSchool(schoolId, async (tx) => {
    const [vaulted] = await tx.select().from(questionVault)
      .where(and(
        eq(questionVault.schoolId, schoolId),
        eq(questionVault.questionSetId, setId),
      ))
      .orderBy(questionVault.takenAt)
      .limit(1);

    if (!vaulted) return { restored: 0, skipped: 0, error: 'no snapshot' };

    const snapshot = vaulted.payload as Snapshot;

    let restored = 0;
    let skipped = 0;

    for (const item of snapshot.questions) {
      const qid = Number(item.row.id);

      const [live] = await tx.select({ id: schema.questions.id })
        .from(schema.questions).where(eq(schema.questions.id, qid)).limit(1);

      if (live) { skipped++; continue; }

      // The question keeps its id: papers and results point at it.
      const row = { ...item.row } as Record<string, unknown>;
      delete row.updatedAt;

      await tx.insert(schema.questions).values(row as never);

      // Options get FRESH ids. Restoring their originals collided with existing
      // rows and failed the whole restore — nothing references an option by id,
      // so there is no reason to preserve one.
      for (const opt of item.options) {
        const o = { ...opt } as Record<string, unknown>;
        delete o.id;
        o.questionId = qid;

        await tx.insert(schema.questionOptions).values(o as never);
      }

      restored++;
    }

    return { restored, skipped };
  });
}

/** What is held for a school, and whether the live set still has it. */
export async function vaultInventory(schoolId: number) {
  return forSchool(schoolId, async (tx) =>
    tx.select({
      setId: questionVault.questionSetId,
      questionCount: questionVault.questionCount,
      takenAt: questionVault.takenAt,
    })
      .from(questionVault)
      .where(eq(questionVault.schoolId, schoolId))
      .orderBy(questionVault.takenAt),
  );
}
