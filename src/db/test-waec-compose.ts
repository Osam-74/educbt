/**
 * WAEC practice must stay apart from the school's own exams: a normal English paper never contains WAEC-structured
 * questions, a WAEC practice paper never contains the teachers' ordinary ones, and the school's real exam is built
 * from the same questions whether or not a WAEC set exists. Isolated fixture schools, removed at the end.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { createSeries, composeSeries, questionAvailability } = await import('@/lib/exam/compose');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const ids: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  /** One school with an ORDINARY English set (school exam, bank 0) and a WAEC English set, same subject and level. */
  async function fixture(opts: { ordinary?: boolean; waec?: boolean; waecInBank?: 'practice' | 'terminal' } = {}) {
    const { ordinary = true, waec = true, waecInBank = 'terminal' } = opts;
    const [school] = await db.insert(schema.schools).values({ name: 'WAEC compose', code: 'WC-' + randomUUID() }).returning();
    const schoolId = school!.id; ids.push(schoolId);
    const [user] = await db.insert(schema.users).values({ schoolId, role: 'exam_officer', loginId: 'officer', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role: 'exam_officer', staffNumber: 'o', firstName: 'Exam', lastName: 'Officer' }).returning();
    const officer: Actor = { schoolId, userId: user!.id, role: 'exam_officer', staffId: staff!.id, studentId: null, loginId: 'officer' };
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS2', stage: 'senior' }).returning();
    await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS2 A' });
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    const mkSeries = (title: string, seriesType: 'examination' | 'ca_test' | 'practice') => createSeries(officer, { title, seriesType, sessionId: session!.id, termId: term!.id, questionsPerStudent: 3, durationMinutes: 30 });
    const practice = await mkSeries('WAEC English practice', 'practice');
    const ca = await mkSeries('First CA test', 'ca_test');
    const exam = await mkSeries('First Term Examination', 'examination');
    let n = 0;
    const mkSet = async (seriesId: number, waecMode: boolean, label: string) => {
      const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id,
        examType: 'objective', seriesId, status: 'approved', teacherId: staff!.id, waecMode }).returning();
      for (let i = 0; i < 4; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: `${label} question ${++n}?`, sequence: n, approvalStatus: 'approved' }).returning();
        await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
      }
      return set!;
    };
    const sets = {
      ordinaryBank: ordinary ? await mkSet(0, false, 'ORDINARY') : null,
      waecBank: waec && waecInBank === 'terminal' ? await mkSet(0, true, 'WAEC') : null,
      waecPractice: waec && waecInBank === 'practice' ? await mkSet(Number(practice.id), true, 'WAEC') : null,
    };
    return { officer, schoolId, series: { practice, ca, exam }, sets, subjectId: subject!.id };
  }
  const textsOf = async (seriesId: number) => {
    const papers = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, seriesId));
    if (papers.length === 0) return [] as string[];
    const pq = await db.select().from(schema.paperQuestions).where(inArray(schema.paperQuestions.paperId, papers.map((p) => p.id)));
    if (pq.length === 0) return [];
    return (await db.select().from(schema.questions).where(inArray(schema.questions.id, pq.map((r) => r.questionId)))).map((q) => q.questionText);
  };

  try {
    await check('the school\'s normal examination is built from its ordinary questions only, even when a WAEC set sits beside it', async () => {
      const f = await fixture();
      await composeSeries(f.officer, Number(f.series.exam.id));
      const texts = await textsOf(Number(f.series.exam.id));
      assert.equal(texts.length, 4, 'one paper from the ordinary set');
      assert.ok(texts.every((t) => t.startsWith('ORDINARY')), 'no WAEC question reached the real exam: ' + texts.join(' | '));
    });
    await check('it makes no difference which set was written first', async () => {
      const f = await fixture({ ordinary: false, waec: true, waecInBank: 'terminal' });
      await composeSeries(f.officer, Number(f.series.exam.id));
      assert.deepEqual(await textsOf(Number(f.series.exam.id)), [], 'with only a WAEC set in the bank there is nothing for the real exam');
    });
    await check('the availability report for the real exam does not count WAEC sets', async () => {
      const f = await fixture();
      const rows = (await questionAvailability(f.officer, Number(f.series.exam.id))).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0]!.setId, f.sets.ordinaryBank!.id);
    });
    await check('a CA test never draws WAEC-structured questions either', async () => {
      const f = await fixture({ ordinary: false, waec: false });
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      const [level] = await db.select().from(schema.classLevels).where(eq(schema.classLevels.schoolId, f.schoolId));
      const [set] = await db.insert(schema.questionSets).values({ schoolId: f.schoolId, sessionId: session!.id, termId: term!.id, subjectId: f.subjectId, levelId: level!.id,
        examType: 'objective', seriesId: Number(f.series.ca.id), status: 'approved', teacherId: f.officer.staffId!, waecMode: true }).returning();
      for (let i = 0; i < 4; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId: f.schoolId, questionSetId: set!.id, questionText: `WAEC in CA ${i}?`, sequence: i + 1, approvalStatus: 'approved' }).returning();
        await db.insert(schema.questionOptions).values([{ schoolId: f.schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId: f.schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
      }
      await composeSeries(f.officer, Number(f.series.ca.id));
      assert.deepEqual(await textsOf(Number(f.series.ca.id)), []);
    });
    await check('a WAEC practice series is built from WAEC sets, and from nothing else', async () => {
      const f = await fixture({ waecInBank: 'practice' });
      await composeSeries(f.officer, Number(f.series.practice.id));
      const texts = await textsOf(Number(f.series.practice.id));
      assert.equal(texts.length, 4); assert.ok(texts.every((t) => t.startsWith('WAEC')), texts.join(' | '));
    });
    await check('an ordinary practice paper (not WAEC) is still built exactly as before', async () => {
      const f = await fixture({ waec: false, ordinary: false });
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      const [level] = await db.select().from(schema.classLevels).where(eq(schema.classLevels.schoolId, f.schoolId));
      const [set] = await db.insert(schema.questionSets).values({ schoolId: f.schoolId, sessionId: session!.id, termId: term!.id, subjectId: f.subjectId, levelId: level!.id,
        examType: 'objective', seriesId: Number(f.series.practice.id), status: 'approved', teacherId: f.officer.staffId!, waecMode: false }).returning();
      for (let i = 0; i < 4; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId: f.schoolId, questionSetId: set!.id, questionText: `PLAIN practice ${i}?`, sequence: i + 1, approvalStatus: 'approved' }).returning();
        await db.insert(schema.questionOptions).values([{ schoolId: f.schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId: f.schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
      }
      await composeSeries(f.officer, Number(f.series.practice.id));
      assert.equal((await textsOf(Number(f.series.practice.id))).length, 4);
    });
    await check('a practice series holding BOTH a WAEC and an ordinary set for one subject and level builds the WAEC paper, not a blend', async () => {
      const f = await fixture({ waecInBank: 'practice', ordinary: false });
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      const [level] = await db.select().from(schema.classLevels).where(eq(schema.classLevels.schoolId, f.schoolId));
      const [plain] = await db.insert(schema.questionSets).values({ schoolId: f.schoolId, sessionId: session!.id, termId: term!.id, subjectId: f.subjectId, levelId: level!.id,
        examType: 'objective', seriesId: Number(f.series.practice.id), status: 'approved', teacherId: f.officer.staffId!, waecMode: false }).returning();
      for (let i = 0; i < 4; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId: f.schoolId, questionSetId: plain!.id, questionText: `PLAIN beside WAEC ${i}?`, sequence: i + 1, approvalStatus: 'approved' }).returning();
        await db.insert(schema.questionOptions).values([{ schoolId: f.schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId: f.schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
      }
      const rows = (await questionAvailability(f.officer, Number(f.series.practice.id))).rows;
      assert.equal(rows.length, 1, 'one row for the scope, not two');
      await composeSeries(f.officer, Number(f.series.practice.id));
      const texts = await textsOf(Number(f.series.practice.id));
      assert.equal(texts.length, 4); assert.ok(texts.every((t) => t.startsWith('WAEC')), texts.join(' | '));
    });
    await check('the one-kind rule is per subject and level: another level keeps its ordinary practice set', async () => {
      const f = await fixture({ waecInBank: 'practice', ordinary: false });
      const [session] = await db.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, f.schoolId));
      const [term] = await db.select().from(schema.terms).where(eq(schema.terms.schoolId, f.schoolId));
      const [jss] = await db.insert(schema.classLevels).values({ schoolId: f.schoolId, name: 'JSS1', stage: 'junior' }).returning();
      await db.insert(schema.classes).values({ schoolId: f.schoolId, levelId: jss!.id, displayName: 'JSS1 A' });
      const [plain] = await db.insert(schema.questionSets).values({ schoolId: f.schoolId, sessionId: session!.id, termId: term!.id, subjectId: f.subjectId, levelId: jss!.id,
        examType: 'objective', seriesId: Number(f.series.practice.id), status: 'approved', teacherId: f.officer.staffId!, waecMode: false }).returning();
      for (let i = 0; i < 4; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId: f.schoolId, questionSetId: plain!.id, questionText: `JSS1 practice ${i}?`, sequence: i + 1, approvalStatus: 'approved' }).returning();
        await db.insert(schema.questionOptions).values([{ schoolId: f.schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId: f.schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
      }
      assert.equal((await questionAvailability(f.officer, Number(f.series.practice.id))).rows.length, 2, 'SS2 (WAEC) and JSS1 (ordinary)');
      await composeSeries(f.officer, Number(f.series.practice.id));
      const texts = await textsOf(Number(f.series.practice.id));
      assert.equal(texts.length, 8); assert.equal(texts.filter((t) => t.startsWith('JSS1')).length, 4); assert.equal(texts.filter((t) => t.startsWith('WAEC')).length, 4);
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (ids.length) await db.delete(schema.schools).where(inArray(schema.schools.id, ids));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
