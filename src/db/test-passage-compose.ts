/**
 * Composing a paper tells the exam office when a comprehension passage will reach students short of questions.
 * Isolated fixture schools, removed at the end. LOCAL disposable database only.
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
  const { createSeries, composeSeries, passageNotes } = await import('@/lib/exam/compose');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const ids: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  async function fixture(perStudent: number, passageShape: Array<{ title: string; approved: boolean[] }>, loose = 0) {
    const [school] = await db.insert(schema.schools).values({ name: 'Compose test', code: 'PC-' + randomUUID() }).returning();
    const schoolId = school!.id; ids.push(schoolId);
    const [user] = await db.insert(schema.users).values({ schoolId, role: 'exam_officer', loginId: 'officer', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role: 'exam_officer', staffNumber: 'o', firstName: 'Exam', lastName: 'Officer' }).returning();
    const officer: Actor = { schoolId, userId: user!.id, role: 'exam_officer', staffId: staff!.id, studentId: null, loginId: 'officer' };
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' });
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English' }).returning();
    const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id,
      examType: 'objective', seriesId: 0, status: 'approved', teacherId: staff!.id }).returning();
    let n = 0;
    const mk = async (passageId: number | null, pos: number, approved: boolean) => {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: `Question ${++n}?`, passageId, passagePosition: pos,
        sequence: n, approvalStatus: approved ? 'approved' : 'pending' }).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
    };
    for (const shape of passageShape) {
      const [p] = await db.insert(schema.passages).values({ schoolId, subjectId: subject!.id, title: shape.title, body: 'A passage that is long enough to be valid.' }).returning();
      for (let i = 0; i < shape.approved.length; i++) await mk(p!.id, i, shape.approved[i]!);
    }
    for (let i = 0; i < loose; i++) await mk(null, 0, true);
    const series = await createSeries(officer, { title: 'First Term Examination', seriesType: 'examination', sessionId: session!.id, termId: term!.id, questionsPerStudent: perStudent, durationMinutes: 30 });
    return { officer, schoolId, series, set: set! };
  }

  try {
    await check('a passage with an unapproved question says so, by title, with the real numbers', async () => {
      const f = await fixture(3, [{ title: 'The Village Market', approved: [true, true, false, true] }]);
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.equal(r.warnings!.length, 1);
      assert.match(r.warnings![0]!, /English JSS1: the passage "The Village Market" will reach students with 3 of its 4 questions, because 1 is not approved\./);
    });
    await check('two unapproved questions use the plural wording', async () => {
      const f = await fixture(2, [{ title: 'Harbour', approved: [true, false, false] }], 3);
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.match(r.warnings!.join(' '), /1 of its 3 questions, because 2 are not approved/);
    });
    await check('a fully approved passage gives NO warning (no false alarm)', async () => {
      const f = await fixture(3, [{ title: 'Complete', approved: [true, true, true] }], 2);
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.deepEqual(r.warnings, []);
      assert.equal(passageNotes(r), '');
    });
    await check('a set with no passages at all gives NO warning', async () => {
      const f = await fixture(3, [], 6);
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.deepEqual(r.warnings, []);
    });
    await check('a paper size that would split a passage is flagged', async () => {
      // one passage of 4 only, a paper of 3: the only way to reach 3 is to cut the passage
      const f = await fixture(3, [{ title: 'Whole or nothing', approved: [true, true, true, true] }]);
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.match(r.warnings!.join(' '), /cannot be made without splitting a passage/);
    });
    await check('a warning never stops the paper being made, and the paper holds the approved questions only', async () => {
      const f = await fixture(3, [{ title: 'Half', approved: [true, false, true, true] }]);
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.equal(r.created, 1);
      const papers = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(f.series.id)));
      const pq = await db.select().from(schema.paperQuestions).where(eq(schema.paperQuestions.paperId, papers[0]!.id));
      assert.equal(pq.length, 3);
    });
    await check('the notes read as one tidy sentence group for the status line', async () => {
      const f = await fixture(3, [{ title: 'Half', approved: [true, false, true, true] }]);
      const note = passageNotes(await composeSeries(f.officer, Number(f.series.id)));
      assert.match(note, /^ Check the passages: English JSS1: the passage "Half"/);
    });
    await check('warnings are written to the audit trail', async () => {
      const f = await fixture(3, [{ title: 'Audited', approved: [true, false, true, true] }]);
      await composeSeries(f.officer, Number(f.series.id));
      const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, f.schoolId));
      const composed = rows.find((r) => r.action === 'exam_series.composed');
      assert.ok(JSON.stringify(composed!.after).includes('Audited'));
    });
    await check('another school\'s passages never appear in this school\'s notes', async () => {
      const a = await fixture(3, [{ title: 'School A passage', approved: [true, false, true, true] }]);
      const b = await fixture(3, [{ title: 'School B passage', approved: [true, true, true, true] }], 3);
      const rb = await composeSeries(b.officer, Number(b.series.id));
      assert.ok(!rb.warnings!.join(' ').includes('School A'));
      const ra = await composeSeries(a.officer, Number(a.series.id));
      assert.ok(!ra.warnings!.join(' ').includes('School B'));
    });
    await check('a second set in the same school does not borrow this set\'s passage problems', async () => {
      // JSS1 English is clean. A different level\'s set has a half-approved passage. Composing must not blame JSS1.
      const f = await fixture(3, [{ title: 'JSS1 clean', approved: [true, true, true] }], 3);
      const [jss2] = await db.insert(schema.classLevels).values({ schoolId: f.schoolId, name: 'JSS2' }).returning();
      await db.insert(schema.classes).values({ schoolId: f.schoolId, levelId: jss2!.id, displayName: 'JSS2 A' });
      const [eng] = await db.select().from(schema.subjects).where(eq(schema.subjects.schoolId, f.schoolId));
      const [first] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.schoolId, f.schoolId));
      const [set2] = await db.insert(schema.questionSets).values({ schoolId: f.schoolId, sessionId: first!.sessionId, termId: first!.termId, subjectId: eng!.id,
        levelId: jss2!.id, examType: 'objective', seriesId: 0, status: 'approved', teacherId: first!.teacherId }).returning();
      const [p2] = await db.insert(schema.passages).values({ schoolId: f.schoolId, subjectId: eng!.id, title: 'JSS2 half', body: 'A passage that is long enough to be valid.' }).returning();
      for (let i = 0; i < 6; i++) {
        const [q] = await db.insert(schema.questions).values({ schoolId: f.schoolId, questionSetId: set2!.id, questionText: `JSS2 question ${i}?`, passageId: i < 3 ? p2!.id : null,
          passagePosition: i, sequence: i + 1, approvalStatus: i === 1 ? 'pending' : 'approved' }).returning();
        await db.insert(schema.questionOptions).values([{ schoolId: f.schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId: f.schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
      }
      const r = await composeSeries(f.officer, Number(f.series.id));
      assert.equal(r.warnings!.filter((w) => w.startsWith('English JSS1')).length, 0, 'JSS1 is clean and must not be blamed');
      assert.equal(r.warnings!.filter((w) => w.startsWith('English JSS2') && w.includes('JSS2 half')).length, 1, 'JSS2 is flagged exactly once');
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (ids.length) await db.delete(schema.schools).where(inArray(schema.schools.id, ids));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
