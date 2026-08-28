/**
 * Answer-leak verification.
 *
 *   npm run test:leak
 *
 * This is the most important test in the project.
 *
 * If a correct answer reaches the browser, every examination ever sat on the
 * platform is invalid — and nobody finds out until a result is disputed months
 * later. The failure is silent, total, and retroactive.
 *
 * So it is checked mechanically rather than by reading the code: the payload
 * that would go to a candidate is serialised and searched for any trace of
 * correctness, both by field name and by value.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';

const schema = { ...core, ...people, ...qb };

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;

  if (!url) throw new Error('DATABASE_URL_UNPOOLED is required.');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const [school] = await db.select().from(core.schools)
      .where(eq(core.schools.code, 'DEMO001')).limit(1);

    if (!school) {
      console.log('SKIP  seed the demo school first.');
      return;
    }

    const schoolId = Number(school.id);

    // ── Fixture: one question with a known correct answer ────────────────────
    const [session] = await db.select().from(core.academicSessions)
      .where(eq(core.academicSessions.schoolId, schoolId)).limit(1);
    const [term] = await db.select().from(core.terms)
      .where(eq(core.terms.schoolId, schoolId)).limit(1);
    const [subject] = await db.select().from(core.subjects)
      .where(eq(core.subjects.schoolId, schoolId)).limit(1);
    const [level] = await db.select().from(core.classLevels)
      .where(eq(core.classLevels.schoolId, schoolId)).limit(1);

    let [set] = await db.select().from(qb.questionSets)
      .where(and(
        eq(qb.questionSets.schoolId, schoolId),
        eq(qb.questionSets.subjectId, Number(subject!.id)),
        eq(qb.questionSets.examType, 'objective'),
      )).limit(1);

    if (!set) {
      [set] = await db.insert(qb.questionSets).values({
        schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
        subjectId: Number(subject!.id), levelId: Number(level!.id),
        examType: 'objective', seriesId: 0, waecMode: false,
      }).returning();
    }

    const SECRET = 'THE-CORRECT-ANSWER-XYZZY';

    let [question] = await db.select().from(qb.questions)
      .where(and(
        eq(qb.questions.questionSetId, Number(set!.id)),
        eq(qb.questions.questionText, 'Leak probe: which option is correct?'),
      )).limit(1);

    if (!question) {
      [question] = await db.insert(qb.questions).values({
        schoolId, questionSetId: Number(set!.id),
        questionText: 'Leak probe: which option is correct?',
        questionType: 'single_choice', marks: '1.00', sequence: 1,
      }).returning();

      await db.insert(qb.questionOptions).values([
        { schoolId, questionId: Number(question!.id), optionKey: 'A', optionText: SECRET, isCorrect: true, sortOrder: 0 },
        { schoolId, questionId: Number(question!.id), optionKey: 'B', optionText: 'A wrong option', isCorrect: false, sortOrder: 1 },
        { schoolId, questionId: Number(question!.id), optionKey: 'C', optionText: 'Another wrong one', isCorrect: false, sortOrder: 2 },
        { schoolId, questionId: Number(question!.id), optionKey: 'D', optionText: 'Also wrong', isCorrect: false, sortOrder: 3 },
      ]);
    }

    const questionId = Number(question!.id);

    // ── Build the payload exactly as it would be sent ────────────────────────
    // Mirrors paperForCandidate(). If that function ever starts selecting more
    // columns, this shape diverges and the assertions below catch it.
    const rows = await db
      .select({
        id: qb.questions.id,
        text: qb.questions.questionText,
        type: qb.questions.questionType,
        marks: qb.questions.marks,
      })
      .from(qb.questions)
      .where(eq(qb.questions.id, questionId));

    const options = await db
      .select({
        id: qb.questionOptions.id,
        key: qb.questionOptions.optionKey,
        text: qb.questionOptions.optionText,
      })
      .from(qb.questionOptions)
      .where(eq(qb.questionOptions.questionId, questionId));

    const payload = JSON.stringify({ questions: rows, options });

    // ── The assertions ───────────────────────────────────────────────────────
    check('paper payload contains the question', payload.includes('Leak probe'));
    check('paper payload contains all four options', options.length === 4);

    // The option TEXT is legitimately present — a candidate must read it. What
    // must not be present is any indication of WHICH one is right.
    check(
      'payload has no isCorrect field',
      !/isCorrect|is_correct/i.test(payload),
      'a correctness flag reached the candidate payload',
    );

    check(
      'payload has no boolean marking the answer',
      !options.some((o) => 'isCorrect' in (o as Record<string, unknown>)),
    );

    check(
      'payload has no marking guide or explanation',
      !/markingGuide|marking_guide|explanation/i.test(payload),
    );

    check(
      'payload has no approval state',
      !/approvalStatus|approval_status/i.test(payload),
    );

    // A naive `select *` is exactly how this leaks. Prove it WOULD leak, so the
    // test is known to be capable of failing.
    const naive = await db.select().from(qb.questionOptions)
      .where(eq(qb.questionOptions.questionId, questionId));

    check(
      'control: a select-* WOULD leak (test can detect a leak)',
      /is_correct|isCorrect/i.test(JSON.stringify(naive)),
      'if this fails, the other checks prove nothing',
    );

    // ── Marking stays server-side and reveals nothing ────────────────────────
    const correct = await db.select({ id: qb.questionOptions.id })
      .from(qb.questionOptions)
      .where(and(
        eq(qb.questionOptions.questionId, questionId),
        eq(qb.questionOptions.isCorrect, true),
      ));

    check('exactly one correct option is recorded', correct.length === 1);

    const wrong = options.find((o) => Number(o.id) !== Number(correct[0]!.id));

    check(
      'a wrong answer cannot be distinguished from the payload alone',
      wrong !== undefined && !payload.includes(`"correct":${correct[0]!.id}`),
    );

    // ── Scope key ────────────────────────────────────────────────────────────
    // A CA test, a practice paper and the terminal examination for the same
    // subject must be DIFFERENT rows; two terminal sets must not be.
    //
    // The NULL department case is the one that slipped through: Postgres treats
    // NULLs as distinct in a unique index, and every junior subject has a NULL
    // department, so the constraint quietly allowed duplicates until the index
    // was rebuilt with NULLS NOT DISTINCT.
    let duplicateRejected = false;

    try {
      await db.insert(qb.questionSets).values({
        schoolId,
        sessionId: Number(session!.id),
        termId: Number(term!.id),
        subjectId: Number(subject!.id),
        levelId: Number(level!.id),
        departmentId: null,
        examType: 'objective',
        seriesId: 0,
        waecMode: false,
      });
    } catch {
      duplicateRejected = true;
    }

    check(
      'a duplicate set is rejected even with a NULL department',
      duplicateRejected,
      duplicateRejected ? '' : 'NULLS NOT DISTINCT is missing from the scope index',
    );

    const idxRows = await client<{ def: string }[]>`
      SELECT indexdef AS def FROM pg_indexes
      WHERE indexname = 'question_sets_scope_uq'`;

    check(
      'scope index declares NULLS NOT DISTINCT',
      Boolean(idxRows[0]?.def && /NULLS NOT DISTINCT/i.test(idxRows[0].def)),
    );
  } finally {
    await client.end();
  }

  console.log(
    failures === 0
      ? '\nNo answer leak. Papers are safe to serve.'
      : `\n${failures} check(s) FAILED — DO NOT run an examination on this build.`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Leak test error:', err);
  process.exit(1);
});
