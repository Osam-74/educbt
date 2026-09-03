/**
 * Practice paper feedback — the hard formal-exam guard.
 *
 *   npm run test:practice
 *
 * Practice feedback exists to teach. The moment an examination can use it, the
 * marking key for every formal paper in a school is exposed. These checks hold
 * the service boundary, not the UI: the API route, the page and any future
 * caller all sit behind practiceFeedback's refusals.
 *
 * Fixtures live in a private school so no other suite's state can make these
 * checks pass or fail — and the school is deleted first so reruns never hit
 * the unique school code.
 */

import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as att from './schema/attempts';
import { db } from '@/db';
import { startAttempt, saveAnswer, submitAttempt } from '@/lib/exam/engine';
import { practiceFeedback, practicePapersFor } from '@/lib/exam/practice';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const client = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });

  try {
    // ── A private world, cleaned of any previous run ──────────────────────────
    await db.delete(core.schools).where(eq(core.schools.code, 'PRACTICE01'));
    await db.delete(core.schools).where(eq(core.schools.code, 'PRACTICE02'));

    const [school] = await db.insert(core.schools).values({
      name: 'Practice Test School', code: 'PRACTICE01', status: 'active',
    }).returning();
    const schoolId = Number(school!.id);

    const [other] = await db.insert(core.schools).values({
      name: 'Other School', code: 'PRACTICE02', status: 'active',
    }).returning();
    const otherSchoolId = Number(other!.id);

    const [session] = await db.insert(core.academicSessions).values({
      schoolId, title: '2026/2027', isCurrent: true,
    }).returning();
    const [term] = await db.insert(core.terms).values({
      schoolId, sessionId: Number(session!.id), title: 'First Term', position: 1, isCurrent: true,
    }).returning();
    const [level] = await db.insert(core.classLevels).values({
      schoolId, name: 'SS1', stage: 'senior', levelOrder: 1,
    }).returning();
    const [subject] = await db.insert(core.subjects).values({
      schoolId, name: 'Mathematics', code: 'MTH', isCompulsory: true,
    }).returning();

    // Real argon2id hashes, not placeholders — db:verify scans every user in
    // every school and a planted non-argon2id hash would rightly fail it.
    const passwordHash = await hash('practice-fixture-password');

    const [userA] = await db.insert(people.users).values({
      schoolId, loginId: 'PRAC-0001', passwordHash,
      role: 'student', status: 'active',
    }).returning();
    const [userB] = await db.insert(people.users).values({
      schoolId, loginId: 'PRAC-0002', passwordHash,
      role: 'student', status: 'active',
    }).returning();

    const [studentA] = await db.insert(people.students).values({
      schoolId, userId: Number(userA!.id), admissionNumber: 'PRAC-0001',
      firstName: 'Ada', lastName: 'Test',
      status: 'active',
    }).returning();
    const [studentB] = await db.insert(people.students).values({
      schoolId, userId: Number(userB!.id), admissionNumber: 'PRAC-0002',
      firstName: 'Bayo', lastName: 'Test',
      status: 'active',
    }).returning();

    // Both students are registered for the subject — registration decides
    // what appears, and student B is registered yet must still be refused.
    for (const s of [studentA, studentB]) {
      await db.insert(people.studentSubjects).values({
        schoolId, studentId: Number(s!.id), subjectId: Number(subject!.id),
        sessionId: Number(session!.id),
      });
    }

    // ── Question fixtures: one approved set per series ────────────────────────
    async function seededQuestions(setId: number, n: number, prefix: string) {
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const [q] = await db.insert(qb.questions).values({
          schoolId, questionSetId: setId,
          questionText: `${prefix} question ${i + 1}`,
          marks: '1',
          explanation: `${prefix} explanation ${i + 1}`,
          approvalStatus: 'approved', status: 'active',
        }).returning();
        ids.push(Number(q!.id));
        await db.insert(qb.questionOptions).values(
          ['A', 'B', 'C', 'D'].map((k, j) => ({
            schoolId, questionId: Number(q!.id), optionKey: k,
            optionText: `${prefix} option ${i + 1}${k}`,
            isCorrect: j === 0, sortOrder: j,
          })),
        );
      }
      return ids;
    }

    async function seriesWithPaper(kind: 'practice' | 'examination', prefix: string) {
      const H = 3600_000;
      const [series] = await db.insert(qb.examSeries).values({
        schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
        title: `${prefix} series`, seriesType: kind,
        status: 'published',
        ...(kind === 'examination' ? {
          sittingOpensAt: new Date(Date.now() - H),
          sittingClosesAt: new Date(Date.now() + H),
        } : {}),
      }).returning();

      const [set] = await db.insert(qb.questionSets).values({
        schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
        subjectId: Number(subject!.id), levelId: Number(level!.id),
        examType: 'objective', seriesId: Number(series!.id),
        status: 'approved', minRequired: 3,
      }).returning();

      const questionIds = await seededQuestions(Number(set!.id), 3, prefix);

      const [paper] = await db.insert(att.examPapers).values({
        schoolId, seriesId: Number(series!.id), subjectId: Number(subject!.id),
        durationSeconds: 1800, questionCount: questionIds.length, status: 'published',
      }).returning();

      await db.insert(att.paperQuestions).values(
        questionIds.map((qid, i) => ({
          schoolId, paperId: Number(paper!.id), questionId: qid, sortOrder: i,
        })),
      );

      return { seriesId: Number(series!.id), paperId: Number(paper!.id), questionIds };
    }

    const practice = await seriesWithPaper('practice', 'Practice');
    const formal = await seriesWithPaper('examination', 'Formal');

    // Options, so answers can be exact.
    const correctByQuestion = new Map<number, number>();
    const wrongByQuestion = new Map<number, number>();
    const allOptions = await db.select({
      id: qb.questionOptions.id, questionId: qb.questionOptions.questionId, isCorrect: qb.questionOptions.isCorrect,
    }).from(qb.questionOptions)
      .where(inArray(qb.questionOptions.questionId, [...practice.questionIds, ...formal.questionIds]));
    for (const o of allOptions) {
      if (o.isCorrect) correctByQuestion.set(Number(o.questionId), Number(o.id));
      else if (!wrongByQuestion.has(Number(o.questionId))) wrongByQuestion.set(Number(o.questionId), Number(o.id));
    }

    // ── (2) Feedback before submission is an answer key ───────────────────────
    const started = await startAttempt(schoolId, practice.paperId, Number(studentA!.id));
    check('practice attempt starts', started.ok, started.ok ? '' : String((started as { reason?: string }).reason));

    if (!started.ok) throw new Error('Practice attempt did not start; cannot continue.');
    const attemptId = started.attemptId;

    const early = await practiceFeedback(schoolId, attemptId, Number(studentA!.id));
    check(
      'an unsubmitted practice attempt is refused feedback',
      !early.ok && early.reason === 'not_submitted',
      early.ok ? 'feedback leaked before submission' : String(early.reason),
    );

    // Answer: question 1 correct, question 2 wrong, question 3 unanswered.
    await saveAnswer(schoolId, attemptId, Number(studentA!.id), {
      questionId: practice.questionIds[0]!,
      optionId: correctByQuestion.get(practice.questionIds[0]!)!,
    });
    await saveAnswer(schoolId, attemptId, Number(studentA!.id), {
      questionId: practice.questionIds[1]!,
      optionId: wrongByQuestion.get(practice.questionIds[1]!)!,
    });

    const submitted = await submitAttempt(schoolId, attemptId, Number(studentA!.id));
    check('practice attempt submits', submitted.ok);

    // ── (1) Feedback after submission, with honest content ────────────────────
    const feedback = await practiceFeedback(schoolId, attemptId, Number(studentA!.id));
    check('a submitted practice attempt earns feedback', feedback.ok);

    if (feedback.ok) {
      const f = feedback.feedback;
      check('the score is the marked score', f.score === 1 && f.maxScore === 3, `${f.score}/${f.maxScore}`);
      check('attempted and correct are counted separately', f.numberAttempted === 2 && f.numberCorrect === 1,
        `${f.numberCorrect} correct of ${f.numberAttempted} attempted`);
      check('the percentage is derived, not stored', f.percentage === 33);

      const q1 = f.questions.find((q) => q.questionId === practice.questionIds[0]);
      const q2 = f.questions.find((q) => q.questionId === practice.questionIds[1]);
      const q3 = f.questions.find((q) => q.questionId === practice.questionIds[2]);

      check(
        'the right answer is labelled right, the wrong one wrong',
        Boolean(q1?.isCorrect && !q2?.isCorrect && !q3?.isCorrect),
      );
      check(
        'the explanation travels — it is why practice exists',
        f.questions.every((q) => q.explanation !== null),
      );
      check(
        'the student answer and the correct answer are both named',
        q1?.studentOptionText !== null && q1?.correctOptionText !== null
          && q3?.studentOptionText === null,
      );
    }

    // ── (7) The payload carries no examiner or authoring fields ───────────────
    if (feedback.ok) {
      const raw = JSON.stringify(feedback.feedback);
      const banned = ['approvalStatus', 'markingGuide', 'questionSetId', 'vault', 'snapshot', 'moderation'];
      const found = banned.filter((b) => raw.includes(b));
      check('feedback carries no approval, marking-guide or vault fields', found.length === 0, found.join(', '));
    }

    // ── (3, 4) Formal attempts are refused — submitted or not ──────────────────
    const formalStarted = await startAttempt(schoolId, formal.paperId, Number(studentA!.id));
    check('the formal attempt starts (window open)', formalStarted.ok,
      formalStarted.ok ? '' : String((formalStarted as { reason?: string }).reason));

    if (formalStarted.ok) {
      const liveFormal = await practiceFeedback(schoolId, formalStarted.attemptId, Number(studentA!.id));
      check(
        'a formal attempt gets no feedback — even mid-paper',
        !liveFormal.ok && liveFormal.reason === 'formal_exam',
        liveFormal.ok ? 'the marking key of a LIVE paper leaked' : String(liveFormal.reason),
      );

      await saveAnswer(schoolId, formalStarted.attemptId, Number(studentA!.id), {
        questionId: formal.questionIds[0]!,
        optionId: correctByQuestion.get(formal.questionIds[0]!)!,
      });
      const formalSubmitted = await submitAttempt(schoolId, formalStarted.attemptId, Number(studentA!.id));
      check('the formal attempt submits (it must, for a fair guard test)', formalSubmitted.ok);

      const submittedFormal = await practiceFeedback(schoolId, formalStarted.attemptId, Number(studentA!.id));
      check(
        'a SUBMITTED formal attempt is refused feedback by the service itself',
        !submittedFormal.ok && submittedFormal.reason === 'formal_exam',
        submittedFormal.ok ? 'an examination marking key leaked through the practice service' : String(submittedFormal.reason),
      );
    }

    // ── (5) Another school learns only that the attempt is not theirs ─────────
    const crossTenant = await practiceFeedback(otherSchoolId, attemptId, Number(studentA!.id));
    check(
      'a request from another school is refused as not found',
      !crossTenant.ok && crossTenant.reason === 'not_found',
      crossTenant.ok ? 'cross-tenant feedback leak' : String(crossTenant.reason),
    );

    // ── (6) Another student of the SAME school is refused ──────────────────────
    const notYours = await practiceFeedback(schoolId, attemptId, Number(studentB!.id));
    check(
      "another student cannot read this student's feedback",
      !notYours.ok && notYours.reason === 'not_yours',
      notYours.ok ? 'another student read the feedback' : String(notYours.reason),
    );

    // A nonsense id is refused too.
    const nonsense = await practiceFeedback(schoolId, 987654321, Number(studentA!.id));
    check('a made-up attempt id is refused', !nonsense.ok && nonsense.reason === 'not_found');

    // ── The practice area lists only this student's own state ─────────────────
    const listA = await practicePapersFor(schoolId, Number(studentA!.id));
    check(
      'the practice area lists the paper with its attempt state',
      listA.length === 1 && listA[0]!.attemptId === attemptId && listA[0]!.attemptStatus === 'submitted',
    );

    const listB = await practicePapersFor(schoolId, Number(studentB!.id));
    check(
      'the other student sees the paper but NOT the attempt',
      listB.length === 1 && listB[0]!.attemptId === null && listB[0]!.attemptStatus === null,
    );
  } finally {
    // Deterministic cleanup: the fixture schools and everything under them
    // (users, students, attempts) are removed, so this suite leaves no
    // durable records and a rerun starts from nothing.
    try {
      await db.delete(core.schools).where(eq(core.schools.code, 'PRACTICE01'));
      await db.delete(core.schools).where(eq(core.schools.code, 'PRACTICE02'));
    } catch {
      // Cleanup is best-effort; the next run's leading delete is the backstop.
    }
    await client.end();
  }

  console.log(failures === 0
    ? '\nPractice feedback holds. Formal papers cannot reach it.'
    : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Practice test error:', e); process.exit(1); });
