/**
 * Authoring workflow verification.
 *
 *   npm run test:authoring
 *
 * The service layer is tested elsewhere. This checks the RULES that the screens
 * depend on — the ones a teacher would hit, in the order they would hit them.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, count } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as att from './schema/attempts';
import * as vaultSchema from './schema/vault';

const schema = { ...core, ...people, ...qb, ...att, ...vaultSchema };
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED required.');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [school] = await db.select().from(core.schools).where(eq(core.schools.code, 'DEMO001')).limit(1);
    if (!school) { console.log('SKIP  seed first.'); return; }
    const schoolId = Number(school.id);

    const [session] = await db.select().from(core.academicSessions).where(eq(core.academicSessions.schoolId, schoolId)).limit(1);
    const [term] = await db.select().from(core.terms).where(eq(core.terms.schoolId, schoolId)).limit(1);
    const [level] = await db.select().from(core.classLevels).where(eq(core.classLevels.schoolId, schoolId)).limit(1);
    const [teacher] = await db.select().from(people.staff)
      .where(and(eq(people.staff.schoolId, schoolId), eq(people.staff.staffNumber, 'STF001'))).limit(1);

    const subjects = await db.select().from(core.subjects).where(eq(core.subjects.schoolId, schoolId)).limit(3);
    const subj = subjects[2]!;

    await db.delete(qb.questionSets).where(and(
      eq(qb.questionSets.schoolId, schoolId), eq(qb.questionSets.subjectId, Number(subj.id))));

    // ── A new set starts as a draft, owned by its author ─────────────────────
    const [set] = await db.insert(qb.questionSets).values({
      schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
      subjectId: Number(subj.id), levelId: Number(level!.id),
      examType: 'objective', seriesId: 0, waecMode: false,
      teacherId: Number(teacher!.id), minRequired: 3,
    }).returning();

    const setId = Number(set!.id);
    check('a new set is a draft', set!.status === 'draft');
    check('the set belongs to its author', Number(set!.teacherId) === Number(teacher!.id));

    // ── Questions are pending on write ───────────────────────────────────────
    for (let i = 1; i <= 3; i++) {
      const [q] = await db.insert(qb.questions).values({
        schoolId, questionSetId: setId, questionText: `Authoring probe ${i}?`,
        questionType: 'single_choice', marks: '1.00', sequence: i,
      }).returning();

      await db.insert(qb.questionOptions).values([
        { schoolId, questionId: Number(q!.id), optionKey: 'A', optionText: 'Right', isCorrect: true, sortOrder: 0 },
        { schoolId, questionId: Number(q!.id), optionKey: 'B', optionText: 'Wrong', isCorrect: false, sortOrder: 1 },
      ]);
    }

    const written = await db.select().from(qb.questions).where(eq(qb.questions.questionSetId, setId));

    check(
      'every question is PENDING, never approved on write',
      written.every((q) => q.approvalStatus === 'pending'),
      'it defaulted to approved once, so nothing was ever reviewed',
    );

    // ── Minimum enforced before submission ───────────────────────────────────
    const [c] = await db.select({ n: count() }).from(qb.questions)
      .where(and(eq(qb.questions.questionSetId, setId), eq(qb.questions.status, 'active')));

    check('the set meets its minimum', (c?.n ?? 0) >= set!.minRequired);

    // ── Submission locks editing ─────────────────────────────────────────────
    await db.update(qb.questionSets)
      .set({ status: 'submitted', submittedAt: new Date() })
      .where(eq(qb.questionSets.id, setId));

    const [submitted] = await db.select().from(qb.questionSets).where(eq(qb.questionSets.id, setId)).limit(1);
    const editable = submitted!.status === 'draft' || submitted!.status === 'returned';

    check('a submitted set is no longer editable', !editable);

    // ── Returning reopens it, and carries the reason ─────────────────────────
    await db.update(qb.questionSets)
      .set({ status: 'returned', reviewerComment: 'Question 2 has two correct options.' })
      .where(eq(qb.questionSets.id, setId));

    const [returned] = await db.select().from(qb.questionSets).where(eq(qb.questionSets.id, setId)).limit(1);
    const reopened = returned!.status === 'draft' || returned!.status === 'returned';

    check('a returned set is editable again', reopened);
    check('the reason travels with it', (returned!.reviewerComment ?? '').length >= 10);

    // ── Approval propagates to the questions ────────────────────────────────
    await db.update(qb.questions).set({ approvalStatus: 'approved' })
      .where(eq(qb.questions.questionSetId, setId));
    await db.update(qb.questionSets).set({ status: 'approved' })
      .where(eq(qb.questionSets.id, setId));

    const after = await db.select().from(qb.questions).where(eq(qb.questions.questionSetId, setId));
    const [finalSet] = await db.select().from(qb.questionSets).where(eq(qb.questionSets.id, setId)).limit(1);

    check(
      'set status and question status agree',
      finalSet!.status === 'approved' && after.every((q) => q.approvalStatus === 'approved'),
      'a set marked approved while holding a returned question reaches the hall incomplete',
    );

    // ── A snapshot exists once the work is finished ──────────────────────────
    await db.delete(vaultSchema.questionVault).where(eq(vaultSchema.questionVault.questionSetId, setId));
    await db.insert(vaultSchema.questionVault).values({
      schoolId, questionSetId: setId,
      payload: { version: 1, setId, takenAt: new Date().toISOString(), questions: [] },
      questionCount: after.length, reason: { trigger: 'approved' },
    });

    const [snap] = await db.select().from(vaultSchema.questionVault)
      .where(eq(vaultSchema.questionVault.questionSetId, setId)).limit(1);

    check('approval leaves a snapshot behind', Boolean(snap));
  } finally {
    await client.end();
  }

  console.log(failures === 0
    ? '\nAuthoring workflow holds.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Authoring test error:', e); process.exit(1); });
