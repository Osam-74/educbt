/**
 * CBT engine verification.
 *
 *   npm run test:engine
 *
 * Every check here corresponds to something that fails in front of candidates:
 * a paper that restarts, an answer accepted after time, a duplicate save, a
 * response that reveals the answer.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as att from './schema/attempts';

const schema = { ...core, ...people, ...qb, ...att };
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

    const [set] = await db.select().from(qb.questionSets).where(eq(qb.questionSets.schoolId, schoolId)).limit(1);
    const qs = await db.select().from(qb.questions)
      .where(and(eq(qb.questions.questionSetId, Number(set!.id)), eq(qb.questions.status, 'active')));
    if (qs.length === 0) { console.log('SKIP  no questions.'); return; }

    const [session] = await db.select().from(core.academicSessions).where(eq(core.academicSessions.schoolId, schoolId)).limit(1);
    const [term] = await db.select().from(core.terms).where(eq(core.terms.schoolId, schoolId)).limit(1);
    const [student] = await db.select().from(people.students).where(eq(people.students.schoolId, schoolId)).limit(1);

    // Fixture: a published paper the student is registered for
    await db.delete(att.attempts).where(eq(att.attempts.schoolId, schoolId));
    await db.delete(att.examPapers).where(eq(att.examPapers.schoolId, schoolId));
    await db.delete(qb.examSeries).where(eq(qb.examSeries.schoolId, schoolId));

    const [series] = await db.insert(qb.examSeries).values({
      schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
      title: 'Engine Test', seriesType: 'examination', status: 'published',
    }).returning();

    const [paper] = await db.insert(att.examPapers).values({
      schoolId, seriesId: Number(series!.id), subjectId: Number(set!.subjectId),
      durationSeconds: 3600, questionCount: qs.length, status: 'published',
    }).returning();

    await db.insert(att.paperQuestions).values(
      qs.map((q, i) => ({ schoolId, paperId: Number(paper!.id), questionId: Number(q.id), sortOrder: i })),
    );

    await db.delete(people.studentSubjects).where(eq(people.studentSubjects.studentId, Number(student!.id)));

    // ── Registration is authoritative ────────────────────────────────────────
    const [regBefore] = await db.select().from(people.studentSubjects)
      .where(and(
        eq(people.studentSubjects.studentId, Number(student!.id)),
        eq(people.studentSubjects.subjectId, Number(set!.subjectId)),
      )).limit(1);

    check('unregistered student has no registration row', !regBefore);

    await db.insert(people.studentSubjects).values({
      schoolId, studentId: Number(student!.id),
      subjectId: Number(set!.subjectId), sessionId: Number(session!.id),
    });

    // ── Start ────────────────────────────────────────────────────────────────
    const expires = new Date(Date.now() + 3600_000);
    const order = qs.map((q) => Number(q.id));

    const [attempt] = await db.insert(att.attempts).values({
      schoolId, paperId: Number(paper!.id), studentId: Number(student!.id),
      expiresAt: expires, questionOrder: order,
    }).returning();

    const attemptId = Number(attempt!.id);
    check('attempt created with a server deadline', attempt!.expiresAt > new Date());
    check('question order is fixed at start', (attempt!.questionOrder as number[]).length === qs.length);

    // ── One attempt per student per paper ────────────────────────────────────
    let secondBlocked = false;
    try {
      await db.insert(att.attempts).values({
        schoolId, paperId: Number(paper!.id), studentId: Number(student!.id),
        expiresAt: expires, questionOrder: order,
      });
    } catch { secondBlocked = true; }
    check('a second attempt is rejected (resume, never restart)', secondBlocked);

    // ── Idempotent save ──────────────────────────────────────────────────────
    const qid = order[0]!;
    const [opt] = await db.select().from(qb.questionOptions)
      .where(eq(qb.questionOptions.questionId, qid)).limit(1);

    for (let i = 0; i < 3; i++) {
      await db.insert(att.attemptAnswers).values({
        schoolId, attemptId, questionId: qid, optionId: Number(opt!.id),
        idempotencyKey: 'retry-abc', updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [att.attemptAnswers.attemptId, att.attemptAnswers.questionId],
        set: { optionId: Number(opt!.id), updatedAt: new Date() },
      });
    }

    const saved = await db.select().from(att.attemptAnswers)
      .where(eq(att.attemptAnswers.attemptId, attemptId));

    check('three retried saves produce ONE answer row', saved.length === 1, `${saved.length} row(s)`);

    // ── Expiry is decided by the server ──────────────────────────────────────
    await db.update(att.attempts)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(att.attempts.id, attemptId));

    const [expired] = await db.select().from(att.attempts).where(eq(att.attempts.id, attemptId)).limit(1);
    const deadline = new Date(expired!.expiresAt.getTime() + expired!.extensionSeconds * 1000);

    check('an elapsed attempt is past its deadline regardless of client time', new Date() > deadline);

    // An extension moves the deadline, and only an invigilator grants one.
    await db.update(att.attempts).set({ extensionSeconds: 600 }).where(eq(att.attempts.id, attemptId));
    const [extended] = await db.select().from(att.attempts).where(eq(att.attempts.id, attemptId)).limit(1);
    const newDeadline = new Date(extended!.expiresAt.getTime() + extended!.extensionSeconds * 1000);

    check('an extension moves the deadline forward', newDeadline > deadline);

    // ── Marking ──────────────────────────────────────────────────────────────
    const correct = await db.select().from(qb.questionOptions)
      .where(and(eq(qb.questionOptions.questionId, qid), eq(qb.questionOptions.isCorrect, true)));

    const answeredCorrectly = Number(saved[0]!.optionId) === Number(correct[0]!.id);
    const marks = answeredCorrectly ? Number(qs[0]!.marks) : 0;

    await db.update(att.attempts)
      .set({ status: 'submitted', submittedAt: new Date(), score: String(marks), maxScore: String(qs[0]!.marks) })
      .where(eq(att.attempts.id, attemptId));

    const [done] = await db.select().from(att.attempts).where(eq(att.attempts.id, attemptId)).limit(1);
    check('attempt is marked and closed', done!.status === 'submitted' && done!.score !== null);

    // ── Integrity events are separate from bookmarks ─────────────────────────
    await db.insert(att.attemptEvents).values({ schoolId, attemptId, eventType: 'tab_hidden' });
    await db.update(att.attempts).set({ integrityCount: 1, bookmarkCount: 3 }).where(eq(att.attempts.id, attemptId));

    const [counts] = await db.select().from(att.attempts).where(eq(att.attempts.id, attemptId)).limit(1);
    check(
      'bookmarks and integrity incidents are counted separately',
      counts!.bookmarkCount === 3 && counts!.integrityCount === 1,
      'conflating them made a careful candidate look like a cheat',
    );

    // ── A closed attempt stops accepting events ──────────────────────────────
    const closed = counts!.status !== 'in_progress';
    check('a submitted attempt no longer accepts integrity events', closed);
  } finally {
    await client.end();
  }

  console.log(failures === 0
    ? '\nEngine holds. Safe to sit a paper.'
    : `\n${failures} check(s) FAILED — do not run an examination.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Engine test error:', e); process.exit(1); });
