/**
 * Background-job verification.
 *
 *   npm run test:jobs
 *
 * Covers the two scheduled services behind the Inngest layer:
 *   - purgeExpiredSessions (src/lib/jobs/session-cleanup.ts)
 *   - sweepAllExpiredAttempts  (src/lib/jobs/exam-sweep.ts → engine sweepExpired)
 *
 * The service/job boundary is what is tested — not the provider. The Inngest
 * glue (src/inngest/*) is five lines per job and is exercised locally via the
 * dev server (README § Background jobs).
 *
 * Fixture standard, as established in test-auth/test-practice: platform-level
 * setup runs on the OWNER connection (creating schools is a platform action
 * the app role rightly cannot do); every behaviour assertion runs through the
 * real application-role services. Timestamps are controlled offsets — nothing
 * waits on wall-clock time.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import { hash } from '@node-rs/argon2';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as att from './schema/attempts';
import { db, schema } from '@/db';
import { hashSessionToken, destroyUserSessions } from '@/lib/auth/session-store';
import { purgeExpiredSessions } from '@/lib/jobs/session-cleanup';
import { sweepAllExpiredAttempts } from '@/lib/jobs/exam-sweep';
import { saveAnswer } from '@/lib/exam/engine';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const H = 3600_000;

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED required.');
  const client = postgres(url, { max: 1 });
  const odb = drizzle(client, { schema: { ...core, ...people, ...qb, ...att } });

  try {
    // ── Fixture: three private schools, wiped of any previous run ──────────
    for (const code of ['JOBS-A', 'JOBS-B', 'JOBS-SUSPENDED']) {
      await odb.delete(core.schools).where(eq(core.schools.code, code));
    }

    const [schoolA] = await odb.insert(core.schools).values({
      name: 'Jobs School A', code: 'JOBS-A', status: 'active',
    }).returning();
    const schoolIdA = Number(schoolA!.id);

    const [schoolB] = await odb.insert(core.schools).values({
      name: 'Jobs School B', code: 'JOBS-B', status: 'active',
    }).returning();
    const schoolIdB = Number(schoolB!.id);

    // Suspended on purpose: the sweep must not touch a suspended school —
    // same active-only window the hostname lookup respects.
    const [schoolS] = await odb.insert(core.schools).values({
      name: 'Jobs School Suspended', code: 'JOBS-SUSPENDED', status: 'suspended',
    }).returning();
    const schoolIdS = Number(schoolS!.id);

    // Real argon2id hashes — db:verify scans every user and would rightly
    // fail a planted non-argon2id hash.
    const passwordHash = await hash('jobs-fixture-password');

    async function schoolFixture(schoolId: number) {
      const [session] = await odb.insert(core.academicSessions).values({
        schoolId, title: '2026/2027', isCurrent: true,
      }).returning();
      const [term] = await odb.insert(core.terms).values({
        schoolId, sessionId: Number(session!.id), title: 'First Term', position: 1, isCurrent: true,
      }).returning();
      const [level] = await odb.insert(core.classLevels).values({
        schoolId, name: 'SS1', stage: 'senior', levelOrder: 1,
      }).returning();
      const [subject] = await odb.insert(core.subjects).values({
        schoolId, name: 'Mathematics', code: 'MTH',
      }).returning();

      // One question set under the FORMAL series holds the 3 objective
      // questions; both papers draw from it via paper_questions. Marking
      // follows attempt.question_order, so the set is FK integrity, not logic.
      const [seriesExam] = await odb.insert(qb.examSeries).values({
        schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
        title: 'jobs examination', seriesType: 'examination', status: 'published',
        sittingOpensAt: new Date(Date.now() - H),
        sittingClosesAt: new Date(Date.now() + H),
      }).returning();
      const [seriesPractice] = await odb.insert(qb.examSeries).values({
        schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
        title: 'jobs practice', seriesType: 'practice', status: 'published',
      }).returning();
      const [set] = await odb.insert(qb.questionSets).values({
        schoolId, sessionId: Number(session!.id), termId: Number(term!.id),
        subjectId: Number(subject!.id), levelId: Number(level!.id),
        examType: 'objective', seriesId: Number(seriesExam!.id),
        status: 'approved', minRequired: 3,
      }).returning();

      const questionIds: number[] = [];
      const optionIds = new Map<number, number[]>();
      for (let i = 0; i < 3; i++) {
        const [q] = await odb.insert(qb.questions).values({
          schoolId, questionSetId: Number(set!.id), questionText: `jobs q${i + 1}`,
          marks: '1', approvalStatus: 'approved', status: 'active',
        }).returning();
        questionIds.push(Number(q!.id));
        const opts = await odb.insert(qb.questionOptions).values(
          ['A', 'B', 'C', 'D'].map((k, j) => ({
            schoolId, questionId: Number(q!.id), optionKey: k,
            optionText: `jobs ${i + 1}${k}`, isCorrect: j === 0, sortOrder: j,
          })),
        ).returning({ id: qb.questionOptions.id });
        optionIds.set(Number(q!.id), opts.map((o) => Number(o.id)));
      }

      async function paperOf(seriesId: number) {
        const [paper] = await odb.insert(att.examPapers).values({
          schoolId, seriesId, subjectId: Number(subject!.id),
          durationSeconds: 1800, questionCount: 3, status: 'published',
        }).returning();
        await odb.insert(att.paperQuestions).values(
          questionIds.map((qid, i) => ({
            schoolId, paperId: Number(paper!.id), questionId: qid, sortOrder: i,
          })),
        );
        return Number(paper!.id);
      }

      const formal = { paperId: await paperOf(Number(seriesExam!.id)) };
      const practice = { paperId: await paperOf(Number(seriesPractice!.id)) };

      const userIds: number[] = [];
      const studentIds: number[] = [];
      for (let i = 0; i < 3; i++) {
        const [user] = await odb.insert(people.users).values({
          schoolId, loginId: `JOBS-${schoolId}-U${i}`, passwordHash, role: 'student', status: 'active',
        }).returning();
        const [student] = await odb.insert(people.students).values({
          schoolId, userId: Number(user!.id), admissionNumber: `JOBS-${schoolId}-S${i}`,
          firstName: 'Jobs', lastName: `Fixture ${i}`, status: 'active',
        }).returning();
        userIds.push(Number(user!.id));
        studentIds.push(Number(student!.id));
      }

      return {
        userId: userIds[0]!, studentIds,
        questionIds, optionIds, formal, practice,
      };
    }

    const fixA = await schoolFixture(schoolIdA);
    const fixB = await schoolFixture(schoolIdB);
    const fixS = await schoolFixture(schoolIdS);

    // Raw attempts with CONTROLLED deadlines — the state sweepExpired targets.
    // startedAt/expiresAt are server-shaped but deterministic; nothing here
    // waits for real time to pass.
    async function rawAttempt(
      schoolId: number,
      studentId: number,
      paperId: number,
      status: 'in_progress' | 'submitted',
      deadlineIn: number,
    ) {
      const [attempt] = await odb.insert(att.attempts).values({
        schoolId, paperId, studentId,
        status,
        startedAt: new Date(Date.now() - 2 * H),
        expiresAt: new Date(Date.now() + deadlineIn),
        ...(status === 'submitted'
          ? { submittedAt: new Date(Date.now() - H), score: '1', maxScore: '3' }
          : {}),
        questionOrder: fixA.questionIds,
      }).returning();
      return Number(attempt!.id);
    }

    const nowMs = Date.now();

    // School A: the full lifecycle matrix.
    const aExpired = await rawAttempt(schoolIdA, fixA.studentIds[0]!, fixA.formal.paperId, 'in_progress', -30 * 60_000);
    const aActive = await rawAttempt(schoolIdA, fixA.studentIds[1]!, fixA.formal.paperId, 'in_progress', 30 * 60_000);
    const aSubmitted = await rawAttempt(schoolIdA, fixA.studentIds[2]!, fixA.formal.paperId, 'submitted', -30 * 60_000);
    const aPracticeExpired = await rawAttempt(schoolIdA, fixA.studentIds[0]!, fixA.practice.paperId, 'in_progress', -15 * 60_000);

    // School B: independent tenant — must be swept by its own scope.
    const bExpired = await rawAttempt(schoolIdB, fixB.studentIds[0]!, fixB.formal.paperId, 'in_progress', -20 * 60_000);

    // Suspended school: must NOT be swept at all.
    const sExpired = await rawAttempt(schoolIdS, fixS.studentIds[0]!, fixS.formal.paperId, 'in_progress', -10 * 60_000);

    // Answers on the expiring attempt: q1 correct, q2 wrong, q3 unanswered.
    const opts = (qid: number, correct: boolean) => {
      const ids = fixA.optionIds.get(qid)!;
      return correct ? ids[0]! : ids[1]!;
    };
    for (const [qid, correct] of [[fixA.questionIds[0]!, true], [fixA.questionIds[1]!, false]] as const) {
      await odb.insert(att.attemptAnswers).values({
        schoolId: schoolIdA, attemptId: aExpired, questionId: qid,
        optionId: opts(qid, correct),
      });
    }
    const bOpts = (qid: number, correct: boolean) => {
      const ids = fixB.optionIds.get(qid)!;
      return correct ? ids[0]! : ids[1]!;
    };
    await odb.insert(att.attemptAnswers).values({
      schoolId: schoolIdB, attemptId: bExpired, questionId: fixB.questionIds[0]!,
      optionId: bOpts(fixB.questionIds[0]!, true),
    });

    const attemptRow = async (id: number) => {
      const [row] = await odb.select().from(att.attempts).where(eq(att.attempts.id, id)).limit(1);
      return row!;
    };
    const answerCount = async (attemptId: number) => {
      const rows = await odb.select({ id: att.attemptAnswers.id })
        .from(att.attemptAnswers).where(eq(att.attemptAnswers.attemptId, attemptId));
      return rows.length;
    };

    // ── (1) Session cleanup ─────────────────────────────────────────────────
    // Fixture sessions with deterministic raw tokens; the row id must be the
    // SHA-256 digest of the token (never the raw token itself).
    const expiredTokenA = 'jobs-expired-token-a';
    const expiredTokenB = 'jobs-expired-token-b';
    const activeTokenA = 'jobs-active-token-a';
    const revokedTokenC = 'jobs-revoked-token-c';

    const [userC] = await odb.insert(people.users).values({
      schoolId: schoolIdA, loginId: 'JOBS-REVOKED', passwordHash, role: 'student', status: 'active',
    }).returning();

    await odb.insert(people.sessions).values([
      { id: hashSessionToken(expiredTokenA), userId: fixA.userId, expiresAt: new Date(nowMs - H) },
      { id: hashSessionToken(expiredTokenB), userId: fixB.userId, expiresAt: new Date(nowMs - H) },
      { id: hashSessionToken(activeTokenA), userId: fixA.userId, expiresAt: new Date(nowMs + H) },
      { id: hashSessionToken(revokedTokenC), userId: Number(userC!.id), expiresAt: new Date(nowMs + H) },
    ]);

    // Password change (or suspension) revokes sessions NOW, before any expiry.
    await destroyUserSessions(Number(userC!.id));

    const sessionRow = async (token: string) => {
      const rows = await odb.select({ id: people.sessions.id })
        .from(people.sessions).where(eq(people.sessions.id, hashSessionToken(token)));
      return rows.length;
    };

    check(
      'session rows store the SHA-256 digest, never the raw token',
      (await sessionRow(activeTokenA)) === 1
        && (await odb.select({ id: people.sessions.id })
          .from(people.sessions)
          .where(eq(people.sessions.id, activeTokenA))).length === 0,
    );

    const purged1 = await purgeExpiredSessions();
    check(
      'the purge returns a count only — no token material can leave the service',
      typeof purged1 === 'number',
    );
    check('both users’ expired sessions are deleted', purged1 >= 2
      && (await sessionRow(expiredTokenA)) === 0
      && (await sessionRow(expiredTokenB)) === 0,
      `purged ${purged1}`);
    check('the active session survives the purge', (await sessionRow(activeTokenA)) === 1);
    check('a password-revoked session is not resurrected', (await sessionRow(revokedTokenC)) === 0);

    const purged2 = await purgeExpiredSessions();
    check('running the purge again is safe and finds nothing (empty workload)',
      purged2 === 0 && (await sessionRow(activeTokenA)) === 1,
      `purged ${purged2}`);

    // ── (2) Expired-attempt sweep ───────────────────────────────────────────
    const before = await attemptRow(aExpired);
    check('the expired attempt is still in_progress before the sweep', before.status === 'in_progress');
    const submittedBefore = await attemptRow(aSubmitted);

    const sweep1 = await sweepAllExpiredAttempts();
    check('the sweep reports every active school and no failures',
      sweep1.failures.length === 0
        && sweep1.schoolsConsidered >= 2
        && sweep1.schoolsSwept === sweep1.schoolsConsidered,
      `schools ${sweep1.schoolsSwept}/${sweep1.schoolsConsidered}, failures ${sweep1.failures.length}`);

    const after = await attemptRow(aExpired);
    check('the expired attempt is auto-submitted by the sweep',
      after.status === 'auto_submitted', `status ${after.status}`);

    check('saved answers remain intact after closure', (await answerCount(aExpired)) === 2);
    const marks = await odb.select({ awarded: att.attemptAnswers.awardedMarks })
      .from(att.attemptAnswers).where(eq(att.attemptAnswers.attemptId, aExpired));
    check(
      'objective answers are marked (1 correct, 1 wrong)',
      marks.length === 2
        && marks.some((m) => Number(m.awarded) === 1)
        && marks.some((m) => Number(m.awarded) === 0),
      marks.map((m) => m.awarded).join(','),
    );
    check('the score matches the marked answers',
      Number(after.score) === 1 && Number(after.maxScore) === 3,
      `${after.score}/${after.maxScore}`);

    const postClose = await saveAnswer(schoolIdA, aExpired, fixA.studentIds[0]!, {
      questionId: fixA.questionIds[2]!, optionId: opts(fixA.questionIds[2]!, true),
    });
    check('the student cannot keep answering after closure',
      !postClose.ok && postClose.reason === 'closed', `reason ${postClose.reason}`);

    const activeRow = await attemptRow(aActive);
    check('an unrelated in-window attempt stays in_progress', activeRow.status === 'in_progress');

    const submittedAfter = await attemptRow(aSubmitted);
    check('an already-submitted attempt is unchanged',
      submittedAfter.status === 'submitted'
        && Number(submittedAfter.score) === 1
        && submittedAfter.submittedAt!.getTime() === submittedBefore.submittedAt!.getTime(),
    );

    const practiceRow = await attemptRow(aPracticeExpired);
    check('a practice attempt past its own deadline closes the same way',
      practiceRow.status === 'auto_submitted', `status ${practiceRow.status}`);

    const bRow = await attemptRow(bExpired);
    check('the other school’s expired attempt was swept by its own scope',
      bRow.status === 'auto_submitted', `status ${bRow.status}`);

    const sRow = await attemptRow(sExpired);
    check('a suspended school is not swept (active-only enumeration)',
      sRow.status === 'in_progress', `status ${sRow.status}`);

    const sweep2 = await sweepAllExpiredAttempts();
    check('running the sweep again closes nothing (idempotent rerun)',
      sweep2.attemptsClosed === 0 && sweep2.failures.length === 0,
      `closed ${sweep2.attemptsClosed}`);
    const after2 = await attemptRow(aExpired);
    check('a rerun does not alter the already-closed attempt',
      after2.status === 'auto_submitted' && Number(after2.score) === 1
        && after2.submittedAt!.getTime() === after.submittedAt!.getTime(),
    );

    // ── Fixture cleanup ─────────────────────────────────────────────────────
    for (const code of ['JOBS-A', 'JOBS-B', 'JOBS-SUSPENDED']) {
      await odb.delete(core.schools).where(eq(core.schools.code, code));
    }
  } finally {
    await client.end();
  }

  console.log(
    failures === 0
      ? 'Background jobs hold. Sessions expire and attempts close on schedule.'
      : `\n${failures} check(s) FAILED.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`Jobs test error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
