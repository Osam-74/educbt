/**
 * Load-test fixture seeder — Phase 1 of the performance/reliability harness.
 *
 * Creates the pilot-shaped scenario on a DISPOSABLE local database:
 *   5 schools × 100 candidates = 500 concurrent exam candidates,
 * each school running one published 60-question objective paper with a wide
 * open sitting window, so the load harness can drive the full candidate
 * journey (sign-in → start → answers → submit) against a running app.
 *
 * Run against a LOCAL/test database ONLY — it refuses to run against a
 * non-loopback host, mirroring the guards in scripts/restore-database.ts.
 *
 *   set -a && . .env.local && set +a && npm run load:seed
 *
 * Emits load/manifest.json: per-school host name, per-candidate loginId,
 * the shared test password, paper id, and one answerable option id per
 * question — everything the k6 harness needs and nothing about correctness.
 *
 * DB discipline (the CI exit-hang lesson, docs/rapid-completion-report.md):
 * every postgres.js client created here is closed in the finally block, and
 * the seeder exits promptly on success.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { writeFileSync, mkdirSync } from 'node:fs';
import { hashPassword } from '../src/lib/auth/password';
import * as core from '../src/db/schema/core';
import * as people from '../src/db/schema/people';
import * as questions from '../src/db/schema/questions';
import * as attempts from '../src/db/schema/attempts';

const SCHOOLS = Number(process.env.LOAD_SCHOOLS ?? 5);
const CANDIDATES_PER_SCHOOL = Number(process.env.LOAD_CANDIDATES ?? 100);
const QUESTIONS_PER_PAPER = Number(process.env.LOAD_QUESTIONS ?? 60);
const TEST_PASSWORD = 'LoadTest#2026';
const MANIFEST_PATH = process.env.LOAD_MANIFEST ?? 'load/manifest.json';
const PREFIX = 'load'; // subdomain prefix: load1, load2, …

// Never against anything remote.
const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
if (!ownerUrl) fail('DATABASE_URL_UNPOOLED is required.');
try {
  const host = new URL(ownerUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    fail('Refusing to seed load-test fixtures against a non-loopback host.');
  }
} catch {
  fail('DATABASE_URL_UNPOOLED is not a parseable URL.');
}

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

const schema = {
  ...core, ...people, ...questions, ...attempts,
  // schema/results & scores are not part of the load journey.
};

async function main() {
  const owner = postgres(ownerUrl!, { max: 1 });
  const db = drizzle(owner, { schema });

  try {
    // Idempotency: everything cascades from the school, so delete the load
    // schools first and re-create clean. Never touches non-load-test rows.
    const existing = await db.select({ id: core.schools.id, code: core.schools.code })
      .from(core.schools)
      .where(eq(core.schools.code, 'LT0001'));
    for (const school of existing) {
      console.log(`INFO  removing previous load-test school id ${school.id}`);
      await owner`DELETE FROM schools WHERE id = ${school.id}`;
    }

    // ONE Argon2 hash shared by all load-test candidates: hashing is ~100ms of
    // CPU each, 500 candidate hashes would add a minute of setup for no extra
    // fidelity — the password check cost per sign-in is what matters.
    const passwordHash = await hashPassword(TEST_PASSWORD);

    const manifest: unknown[] = [];

    for (let s = 1; s <= SCHOOLS; s++) {
      const subdomain = `${PREFIX}${s}`;
      const [school] = await db.insert(core.schools).values({
        name: `Load Test School ${s}`,
        code: `LT${String(s).padStart(4, '0')}`,
        subdomain,
        status: 'active',
      }).returning();
      const schoolId = school!.id;

      const [session] = await db.insert(core.academicSessions).values({
        schoolId, title: '2026/2027', isCurrent: true,
      }).returning();

      const [term] = await db.insert(core.terms).values({
        schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true,
      }).returning();

      const [level] = await db.insert(core.classLevels).values({
        schoolId, name: 'SS3', stage: 'senior', levelOrder: 1,
      }).returning();

      const [department] = await db.insert(core.departments).values({
        schoolId, name: 'Science', sortOrder: 1,
      }).returning();

      const [cls] = await db.insert(core.classes).values({
        schoolId, levelId: level!.id, departmentId: department!.id,
        arm: 'A', displayName: 'SS3 Science A', status: 'active',
      }).returning();

      const [subject] = await db.insert(core.subjects).values({
        schoolId, name: 'Load Studies', code: 'LDS',
        stage: 'senior', category: 'core', isCompulsory: true,
      }).returning();

      // ── The examination series: published, sitting window wide open ──────
      const now = Date.now();
      const [series] = await db.insert(questions.examSeries).values({
        schoolId,
        sessionId: session!.id,
        termId: term!.id,
        title: 'Load Test Examination',
        seriesType: 'examination',
        sittingOpensAt: new Date(now - 60 * 60 * 1000),
        sittingClosesAt: new Date(now + 8 * 60 * 60 * 1000),
        questionsPerStudent: QUESTIONS_PER_PAPER,
        durationMinutes: 60,
        status: 'published',
      }).returning();

      // ── Question set + questions (approved, active) ──────────────────────
      const [set] = await db.insert(questions.questionSets).values({
        schoolId,
        sessionId: session!.id,
        termId: term!.id,
        subjectId: subject!.id,
        levelId: level!.id,
        departmentId: department!.id,
        classId: cls!.id,
        examType: 'objective',
        deliveryMode: 'cbt',
        seriesId: Number(series!.id),
        status: 'published',
        minRequired: QUESTIONS_PER_PAPER,
      }).returning();

      const optionIds: Array<{ questionId: number; optionId: number }> = [];
      for (let q = 1; q <= QUESTIONS_PER_PAPER; q++) {
        const [question] = await db.insert(questions.questions).values({
          schoolId,
          questionSetId: set!.id,
          questionText: `Load test question ${q}: pick the correct statement about capacity planning.`,
          questionType: 'single_choice',
          marks: '1.00',
          sequence: q,
          approvalStatus: 'approved',
          status: 'active',
        }).returning();

        const [firstOption] = await db.insert(questions.questionOptions).values([
          { schoolId, questionId: question!.id, optionKey: 'A', optionText: `Option A for Q${q}`, isCorrect: q % 4 === 0, sortOrder: 1 },
          { schoolId, questionId: question!.id, optionKey: 'B', optionText: `Option B for Q${q}`, isCorrect: q % 4 === 1, sortOrder: 2 },
          { schoolId, questionId: question!.id, optionKey: 'C', optionText: `Option C for Q${q}`, isCorrect: q % 4 === 2, sortOrder: 3 },
          { schoolId, questionId: question!.id, optionKey: 'D', optionText: `Option D for Q${q}`, isCorrect: q % 4 === 3, sortOrder: 4 },
        ]).returning();

        // One answerable option per question is all the harness needs.
        optionIds.push({ questionId: Number(question!.id), optionId: Number(firstOption!.id) });
      }

      // ── The paper: published, full pool, generous duration ────────────────
      const [paper] = await db.insert(attempts.examPapers).values({
        schoolId,
        seriesId: Number(series!.id),
        subjectId: subject!.id,
        levelId: level!.id,
        departmentId: department!.id,
        classId: cls!.id,
        scheduledAt: new Date(now),
        closesAt: new Date(now + 8 * 60 * 60 * 1000),
        venue: 'Load Test Hall',
        durationSeconds: 3600,
        questionCount: QUESTIONS_PER_PAPER,
        shuffleQuestions: true,
        shuffleOptions: true,
        status: 'published',
      }).returning();

      await db.insert(attempts.paperQuestions).values(
        optionIds.map((o, i) => ({
          schoolId,
          paperId: Number(paper!.id),
          questionId: o.questionId,
          sortOrder: i + 1,
        })),
      );

      // ── Candidates: user + student + subject registration ─────────────────
      const loginIds: string[] = [];
      for (let c = 1; c <= CANDIDATES_PER_SCHOOL; c++) {
        const loginId = `cand${String(c).padStart(3, '0')}`;
        const [user] = await db.insert(people.users).values({
          schoolId,
          role: 'student',
          loginId,
          passwordHash,
          mustChangePassword: false,
          status: 'active',
        }).returning();

        const [student] = await db.insert(people.students).values({
          schoolId,
          userId: user!.id,
          admissionNumber: loginId.toUpperCase(),
          firstName: `Candidate${c}`,
          lastName: `Load${s}`,
          status: 'active',
        }).returning();

        await db.insert(people.studentSubjects).values({
          schoolId,
          studentId: student!.id,
          subjectId: subject!.id,
          sessionId: session!.id,
        });

        loginIds.push(loginId);
      }

      manifest.push({
        school: s,
        subdomain,
        host: `${subdomain}.localhost`,
        paperId: Number(paper!.id),
        password: TEST_PASSWORD,
        candidates: loginIds,
        answers: optionIds,
      });

      console.log(`OK    school ${s}: id=${schoolId} paper=${paper!.id} candidates=${loginIds.length}`);
    }

    mkdirSync('load', { recursive: true });
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`OK    manifest written to ${MANIFEST_PATH}`);
    console.log(`OK    ${SCHOOLS} schools × ${CANDIDATES_PER_SCHOOL} candidates seeded`);
  } finally {
    // CI exit-hang lesson: a passing run must not leave the client open.
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
