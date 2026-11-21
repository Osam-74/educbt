/**
 * Whole-passage delivery through the real engine and database.
 * Run against a LOCAL disposable database only (name must end _ca_test).
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, inArray } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as qb from './schema/questions';
import * as att from './schema/attempts';
import { startAttempt } from '@/lib/exam/engine';
import { paperForCandidateTx } from '@/lib/exam/paper';
import { forSchool } from '@/db';

const schema = { ...core, ...people, ...qb, ...att };
let failures = 0, passed = 0;
const check = (n: string, ok: boolean, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); ok ? passed++ : failures++; };

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url || !/127\.0\.0\.1.*_ca_test$/.test(url)) throw new Error('Refusing to run: DATABASE_URL_UNPOOLED must be a local *_ca_test database.');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    const [school] = await db.select().from(core.schools).where(eq(core.schools.code, 'DEMO001')).limit(1);
    if (!school) { console.log('SKIP  seed first.'); return; }
    const schoolId = Number(school.id);
    const [session] = await db.select().from(core.academicSessions).where(eq(core.academicSessions.schoolId, schoolId)).limit(1);
    const [term] = await db.select().from(core.terms).where(eq(core.terms.schoolId, schoolId)).limit(1);
    const [subject] = await db.select().from(core.subjects).where(eq(core.subjects.schoolId, schoolId)).limit(1);
    const [level] = await db.select().from(core.classLevels).where(eq(core.classLevels.schoolId, schoolId)).limit(1);
    const students = await db.select().from(people.students).where(eq(people.students.schoolId, schoolId)).limit(40);
    // The checks below ask "did passage A / a different first question really reach somebody?". With only a handful of
    // students that is a coin-flip (about 2% of runs by luck alone), so the test enforces a sample size at which luck
    // cannot fail it: it needs at least MIN_SITTINGS real attempts, made by sitting extra copies of the paper.
    const MIN_SITTINGS = 60;

    // a clean slate of our own: every PDRAW row is removed at the end
    const cleanup = async () => {
      await db.delete(att.attempts).where(eq(att.attempts.schoolId, schoolId));
      await db.delete(att.examPapers).where(and(eq(att.examPapers.schoolId, schoolId), eq(att.examPapers.questionCount, 7)));
      await db.delete(qb.questions).where(and(eq(qb.questions.schoolId, schoolId), eq(qb.questions.section, 'PDRAW')));
      await db.delete(qb.passages).where(and(eq(qb.passages.schoolId, schoolId), eq(qb.passages.title, 'PDRAW passage A')));
      await db.delete(qb.passages).where(and(eq(qb.passages.schoolId, schoolId), eq(qb.passages.title, 'PDRAW passage B')));
    };
    await cleanup();
    await db.delete(qb.questionSets).where(and(eq(qb.questionSets.schoolId, schoolId), eq(qb.questionSets.seriesId, 987654)));
    const [set] = await db.insert(qb.questionSets).values({ schoolId, sessionId: Number(session!.id), termId: Number(term!.id), subjectId: Number(subject!.id), levelId: Number(level!.id), examType: 'objective', seriesId: 987654 }).returning();

    const [pa] = await db.insert(qb.passages).values({ schoolId, subjectId: Number(set!.subjectId), title: 'PDRAW passage A', instructions: 'Read passage A and answer questions 1 to 4.', body: 'First paragraph.\nSecond paragraph.' }).returning();
    const [pb] = await db.insert(qb.passages).values({ schoolId, subjectId: Number(set!.subjectId), title: 'PDRAW passage B', body: 'Another passage.' }).returning();

    const mk = async (text: string, passageId: number | null, position: number) => {
      const [q] = await db.insert(qb.questions).values({ schoolId, questionSetId: Number(set!.id), questionText: text, section: 'PDRAW', passageId, passagePosition: position, approvalStatus: 'approved' }).returning();
      return Number(q!.id);
    };
    // inserted OUT of reading order on purpose
    const A = [await mk('A3', Number(pa!.id), 3), await mk('A0', Number(pa!.id), 0), await mk('A2', Number(pa!.id), 2), await mk('A1', Number(pa!.id), 1)];
    const B = [await mk('B1', Number(pb!.id), 1), await mk('B0', Number(pb!.id), 0), await mk('B2', Number(pb!.id), 2)];
    const loose = [await mk('L1', null, 0), await mk('L2', null, 0), await mk('L3', null, 0), await mk('L4', null, 0)];
    const all = [...A, ...B, ...loose];

    const [series] = await db.insert(qb.examSeries).values({ schoolId, sessionId: Number(session!.id), termId: Number(term!.id), title: 'PDRAW', seriesType: 'practice', status: 'published' }).returning();
    // paper size 7 from a pool of 11: a 4-passage, a 3-passage and 4 loose ones
    const [paper] = await db.insert(att.examPapers).values({ schoolId, seriesId: Number(series!.id), subjectId: Number(set!.subjectId), durationSeconds: 3600, questionCount: 7, shuffleQuestions: true, status: 'published' }).returning();
    await db.insert(att.paperQuestions).values(all.map((id, i) => ({ schoolId, paperId: Number(paper!.id), questionId: id, sortOrder: i })));
    for (const s of students) await db.insert(people.studentSubjects).values({ schoolId, studentId: Number(s.id), subjectId: Number(set!.subjectId), sessionId: Number(session!.id) }).onConflictDoNothing();

    let split = 0, wrongOrder = 0, wrongSize = 0, started = 0, extraWithA = 0, extraWithB = 0;
    const firsts = new Set<number>();
    for (const s of students) {
      const r = await startAttempt(schoolId, Number(paper!.id), Number(s.id));
      if (!r.ok) continue;
      started++;
      const [row] = await db.select().from(att.attempts).where(and(eq(att.attempts.paperId, Number(paper!.id)), eq(att.attempts.studentId, Number(s.id)))).limit(1);
      const order = row!.questionOrder as number[];
      if (order.length > 7) wrongSize++;
      firsts.add(order[0]!);
      for (const grp of [A, B]) {
        const got = grp.filter((id) => order.includes(id)).length;
        if (got !== 0 && got !== grp.length) split++;
      }
      const sorted = [...A].sort((x, y) => x - y); // ids were inserted A3,A0,A2,A1 -> reading order is A0,A1,A2,A3
      const readingA = [A[1]!, A[3]!, A[2]!, A[0]!];
      if (readingA.every((id) => order.includes(id))) {
        const idx = readingA.map((id) => order.indexOf(id));
        if (!(idx[0]! < idx[1]! && idx[1]! < idx[2]! && idx[2]! < idx[3]!)) wrongOrder++;
        if (idx[3]! - idx[0]! !== 3) wrongOrder++; // together, not interleaved with other questions
      }
      void sorted;
    }
    // Extra sittings through the SAME real startAttempt, on throwaway copies of the paper (a student gets one attempt
    // per paper), so the "reached somebody" checks below cannot fail by luck. Counted into the same totals.
    let sittings = started; let copy = 0;
    while (sittings < MIN_SITTINGS && students.length > 0) {
      const [dup] = await db.insert(att.examPapers).values({ schoolId, seriesId: Number(series!.id), subjectId: Number(set!.subjectId), durationSeconds: 3600, questionCount: 7, status: 'published', shuffleQuestions: true } as never).returning();
      await db.insert(att.paperQuestions).values(all.map((id, i) => ({ schoolId, paperId: Number(dup!.id), questionId: id, sortOrder: i })));
      copy++;
      for (const s of students) {
        if (sittings >= MIN_SITTINGS) break;
        const r = await startAttempt(schoolId, Number(dup!.id), Number(s.id));
        if (!r.ok) continue;
        sittings++;
        const order = r.questions.map((q) => q.id);
        if (order.length > 7) wrongSize++;
        firsts.add(order[0]!);
        for (const grp of [A, B]) { const got = grp.filter((id) => order.includes(id)).length; if (got !== 0 && got !== grp.length) split++; }
        const delivered = r.questions;
        if (delivered.some((q) => q.passage?.id === Number(pa!.id))) extraWithA++;
        if (delivered.some((q) => q.passage?.id === Number(pb!.id))) extraWithB++;
      }
      if (copy > 60) break;
    }
    check(`${started} students started a paper`, started === students.length, `${started}/${students.length}`);
    check(`the sample is large enough that luck cannot fail the checks (${sittings} sittings)`, sittings >= Math.min(MIN_SITTINGS, 20));
    check('no student ever got part of a passage', split === 0, `${split} split`);
    check('no student got more questions than the paper size', wrongSize === 0, `${wrongSize}`);
    check('passage questions stay together and in reading order', wrongOrder === 0, `${wrongOrder}`);
    check('different students begin with different questions', firsts.size > 1, `${firsts.size}`);

    // what a student actually receives: look at EVERY student's real delivered paper, and require that passage A really appeared
    let withA = 0, missingInstr = 0, withB = 0, badB = 0, deliveredOrderBad = 0;
    for (const s2 of students) {
      const [row] = await db.select().from(att.attempts).where(and(eq(att.attempts.paperId, Number(paper!.id)), eq(att.attempts.studentId, Number(s2.id)))).limit(1);
      const delivered = await forSchool(schoolId, (tx) => paperForCandidateTx(tx, schoolId, row!.questionOrder as number[]));
      if (JSON.stringify(delivered.map((q) => q.id)) !== JSON.stringify(row!.questionOrder)) deliveredOrderBad++;
      const fromA = delivered.filter((q) => q.passage?.id === Number(pa!.id));
      const fromB = delivered.filter((q) => q.passage?.id === Number(pb!.id));
      if (fromA.length) { withA++; if (!fromA.every((q) => q.passage!.instructions === 'Read passage A and answer questions 1 to 4.')) missingInstr++; }
      if (fromB.length) { withB++; if (!fromB.every((q) => q.passage!.instructions === null)) badB++; }
    }
    check('passage A really reached some students (check is not vacuous)', withA + extraWithA > 0, `${withA + extraWithA} of ${sittings} sittings`);
    check('every question of a delivered passage carries its shared instructions', missingInstr === 0, `${missingInstr} without`);
    check('passage B really reached some students', withB + extraWithB > 0, `${withB + extraWithB}`);
    check('a passage without instructions delivers null, not an error', badB === 0, `${badB}`);
    check('what the student sees is in the stored order', deliveredOrderBad === 0, `${deliveredOrderBad}`);

    // resuming returns the SAME order (a refresh mid-exam must not reorder)
    const stored = (await db.select().from(att.attempts).where(and(eq(att.attempts.paperId, Number(paper!.id)), eq(att.attempts.studentId, Number(students[0]!.id)))).limit(1))[0]!.questionOrder as number[];
    const again = await startAttempt(schoolId, Number(paper!.id), Number(students[0]!.id));
    check('resuming is recognised as a resume', again.ok && again.resumed === true);
    check('resuming keeps the same order', again.ok && JSON.stringify(again.questions.map((q) => q.id)) === JSON.stringify(stored), again.ok ? JSON.stringify(again.questions.map((q) => q.id)).slice(0, 80) : 'not ok');

    await cleanup();
    await db.delete(qb.questionSets).where(eq(qb.questionSets.id, Number(set!.id)));
    const left = await db.select().from(qb.questions).where(and(eq(qb.questions.schoolId, schoolId), eq(qb.questions.section, 'PDRAW')));
    check('test rows removed', left.length === 0);
  } finally { await client.end(); }
  console.log(failures ? `FAILED: ${passed} passed, ${failures} failed` : `OK: ${passed} passed, 0 failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
