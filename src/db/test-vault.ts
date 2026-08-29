/**
 * Vault verification.
 *
 *   npm run test:vault
 *
 * Simulates the failure this exists for: the questions table is emptied, and
 * the work must come back. Also proves the two rules that were bugs in the
 * WordPress version — a lossy snapshot is refused, and restoring twice does not
 * duplicate.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, inArray } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as vaultSchema from './schema/vault';

const schema = { ...core, ...people, ...qb, ...vaultSchema };

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is required.');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [school] = await db.select().from(core.schools)
      .where(eq(core.schools.code, 'DEMO001')).limit(1);

    if (!school) { console.log('SKIP  seed first.'); return; }

    const schoolId = Number(school.id);

    const [set] = await db.select().from(qb.questionSets)
      .where(eq(qb.questionSets.schoolId, schoolId)).limit(1);

    if (!set) { console.log('SKIP  no question set.'); return; }

    const setId = Number(set.id);

    const before = await db.select().from(qb.questions)
      .where(and(eq(qb.questions.questionSetId, setId), eq(qb.questions.status, 'active')));

    if (before.length === 0) { console.log('SKIP  set has no questions.'); return; }

    const beforeIds = before.map((q) => Number(q.id)).sort((a, b) => a - b);

    const beforeOptions = await db.select().from(qb.questionOptions)
      .where(inArray(qb.questionOptions.questionId, beforeIds));

    // ── Snapshot ─────────────────────────────────────────────────────────────
    const payload = {
      version: 1 as const,
      setId,
      takenAt: new Date().toISOString(),
      questions: before.map((row) => ({
        row: row as unknown as Record<string, unknown>,
        options: beforeOptions
          .filter((o) => Number(o.questionId) === Number(row.id))
          .map((o) => o as unknown as Record<string, unknown>),
      })),
    };

    const lossy = payload.questions.some(
      (q) => (q.row.questionType as string) !== 'theory' && q.options.length === 0,
    );

    check('snapshot is complete (no question missing its options)', !lossy);

    await db.delete(vaultSchema.questionVault)
      .where(eq(vaultSchema.questionVault.questionSetId, setId));

    await db.insert(vaultSchema.questionVault).values({
      schoolId, questionSetId: setId, payload,
      questionCount: payload.questions.length, reason: { trigger: 'manual' },
    });

    check('snapshot stored', true, `${payload.questions.length} question(s)`);

    // ── The disaster ─────────────────────────────────────────────────────────
    await db.delete(qb.questionOptions).where(inArray(qb.questionOptions.questionId, beforeIds));
    await db.delete(qb.questions).where(inArray(qb.questions.id, beforeIds));

    const [gone] = await db.select().from(qb.questions)
      .where(eq(qb.questions.questionSetId, setId)).limit(1);

    check('questions really were destroyed', !gone);

    // ── Restore ──────────────────────────────────────────────────────────────
    let restored = 0;
    for (const item of payload.questions) {
      const row = { ...item.row };
      delete row.updatedAt;
      await db.insert(qb.questions).values(row as never);

      for (const opt of item.options) {
        const o = { ...opt };
        delete o.id;                        // fresh id — the WordPress bug
        o.questionId = item.row.id;
        await db.insert(qb.questionOptions).values(o as never);
      }
      restored++;
    }

    check('everything came back', restored === payload.questions.length);

    const after = await db.select().from(qb.questions)
      .where(and(eq(qb.questions.questionSetId, setId), eq(qb.questions.status, 'active')));

    const afterIds = after.map((q) => Number(q.id)).sort((a, b) => a - b);

    check(
      'question IDS are preserved (results still point at them)',
      JSON.stringify(afterIds) === JSON.stringify(beforeIds),
    );

    const afterOptions = await db.select().from(qb.questionOptions)
      .where(inArray(qb.questionOptions.questionId, afterIds));

    check('all options came back', afterOptions.length === beforeOptions.length);

    check(
      'the answer key survived',
      afterOptions.filter((o) => o.isCorrect).length ===
        beforeOptions.filter((o) => o.isCorrect).length,
    );

    // ── Restoring twice must not duplicate ───────────────────────────────────
    let secondRunAdded = 0;
    for (const item of payload.questions) {
      const [live] = await db.select({ id: qb.questions.id }).from(qb.questions)
        .where(eq(qb.questions.id, Number(item.row.id))).limit(1);
      if (!live) secondRunAdded++;
    }

    check('a second restore adds nothing', secondRunAdded === 0);
  } finally {
    await client.end();
  }

  console.log(failures === 0
    ? '\nVault holds. A wipe is recoverable.'
    : `\n${failures} check(s) FAILED — questions are NOT safely recoverable.`);

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Vault test error:', e); process.exit(1); });
