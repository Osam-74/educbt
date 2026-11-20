/**
 * Passage authoring: create, edit, delete, and every rule that protects a school's questions.
 * Runs only against a disposable LOCAL database. Fixture schools are removed at the end.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, inArray } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { findOrCreateSet, addQuestion, submitSet } = await import('@/lib/exam/sets');
  const { saveCollection } = await import('@/lib/exam/collection');
  const P = await import('@/lib/exam/passages');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const ids: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Passage test', code: 'PA-' + randomUUID() }).returning();
    const schoolId = school!.id; ids.push(schoolId);
    const actors: Record<string, Actor> = {};
    for (const name of ['principal', 'teacher', 'unassigned', 'student']) {
      const role = name === 'unassigned' ? 'teacher' : name as 'principal' | 'teacher' | 'student';
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: name, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = role === 'student' ? [] : await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: name, firstName: 'Test', lastName: name }).returning();
      actors[name] = { schoolId, userId: user!.id, role, staffId: staff?.id ?? null, studentId: null, loginId: name };
    }
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English' }).returning();
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Maths' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: actors.teacher!.staffId!, subjectId: english!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    return { schoolId, actors, english: english!, maths: maths!, series: series!, session: session!, term: term!, level: level!,
      scope: { sessionId: session!.id, termId: term!.id, subjectId: english!.id, levelId: level!.id, departmentId: null, seriesId: 0, examType: 'objective' as const, waecMode: false } };
  }
  const opts = [{ text: 'Yes', isCorrect: true }, { text: 'No', isCorrect: false }];
  const body = 'The market opens at dawn. Traders arrange their goods while the first customers arrive.';

  try {
    const a = await fixture(); const b = await fixture();
    const principal = a.actors.principal!, teacher = a.actors.teacher!, unassigned = a.actors.unassigned!, student = a.actors.student!;
    await saveCollection(principal, { objective: 1, theory: 1, seriesId: a.series.id });
    const set = await findOrCreateSet(teacher, a.scope);

    // ── create ─────────────────────────────────────────────────────────────
    let pass!: { id: number };
    await check('a teacher assigned to the subject can create a passage with its instruction', async () => {
      pass = await P.createPassage(teacher, { subjectId: a.english.id, title: 'The Village Market', instructions: 'Read the passage and answer questions 1 to 3.', body }) as { id: number };
      const [row] = await db.select().from(schema.passages).where(eq(schema.passages.id, pass.id));
      assert.equal(row!.instructions, 'Read the passage and answer questions 1 to 3.');
      assert.equal(Number(row!.schoolId), a.schoolId);
    });
    await check('a teacher NOT assigned to the subject cannot create one', () => assert.rejects(P.createPassage(unassigned, { subjectId: a.english.id, title: 'Sneaky', body }), /not assigned/));
    await check('a teacher cannot write a passage for a subject they do not teach', () => assert.rejects(P.createPassage(teacher, { subjectId: a.maths.id, title: 'Wrong subject', body }), /not assigned/));
    await check('a student cannot create one', () => assert.rejects(P.createPassage(student, { subjectId: a.english.id, title: 'Student passage', body })));
    await check('the principal (school-wide) can create one for any subject', async () => { await P.createPassage(principal, { subjectId: a.maths.id, title: 'Maths reading', body }); });
    await check('a subject in another school is refused', () => assert.rejects(P.createPassage(teacher, { subjectId: b.english.id, title: 'Foreign', body }), /valid subject|not assigned/));
    await check('a title is required', () => assert.rejects(P.createPassage(teacher, { subjectId: a.english.id, title: ' ', body }), /title/));
    await check('a real passage text is required', () => assert.rejects(P.createPassage(teacher, { subjectId: a.english.id, title: 'Too short', body: 'Hi' }), /passage itself/));
    await check('the same title twice for one subject is refused', () => assert.rejects(P.createPassage(teacher, { subjectId: a.english.id, title: 'the village market', body }), /already exists/));
    await check('a blank instruction is stored as nothing, not as an empty string', async () => {
      const p = await P.createPassage(teacher, { subjectId: a.english.id, title: 'No instruction', instructions: '   ', body }) as { id: number };
      const [row] = await db.select().from(schema.passages).where(eq(schema.passages.id, p.id));
      assert.equal(row!.instructions, null);
    });

    // ── questions on a passage keep reading order ───────────────────────────
    const q: number[] = [];
    await check('questions written on a passage are numbered in reading order', async () => {
      for (const t of ['Who opens the market?', 'When does it open?', 'What do traders arrange?']) {
        const r = await addQuestion(teacher, set.id, { text: t, marks: 1, options: opts, passageId: pass.id }) as { id: number };
        q.push(Number(r.id));
      }
      const rows = await db.select().from(schema.questions).where(inArray(schema.questions.id, q));
      assert.deepEqual(q.map((id) => rows.find((r) => Number(r.id) === id)!.passagePosition), [0, 1, 2]);
    });
    await check('a question cannot be attached to a passage from another school', async () => {
      const foreign = await P.createPassage(b.actors.principal!, { subjectId: b.english.id, title: 'Foreign passage', body }) as { id: number };
      await assert.rejects(addQuestion(teacher, set.id, { text: 'Cross school question?', marks: 1, options: opts, passageId: foreign.id }), /passage/);
    });
    await check('a question cannot be attached to a passage of a different subject', async () => {
      const [m] = await db.select().from(schema.passages).where(and(eq(schema.passages.schoolId, a.schoolId), eq(schema.passages.subjectId, a.maths.id)));
      await assert.rejects(addQuestion(teacher, set.id, { text: 'Wrong subject question?', marks: 1, options: opts, passageId: m!.id }), /passage/);
    });

    // ── list ───────────────────────────────────────────────────────────────
    await check('the list shows the passage with its question count', async () => {
      const list = await P.listPassages(teacher, a.english.id);
      const mine = list.find((p) => Number(p.id) === pass.id)!;
      assert.equal(mine.questions, 3);
      assert.equal(mine.instructions, 'Read the passage and answer questions 1 to 3.');
    });
    await check('the list never shows another school\'s passages', async () => {
      await P.createPassage(b.actors.principal!, { subjectId: b.english.id, title: 'Other school only', body });
      assert.ok(!(await P.listPassages(teacher, a.english.id)).some((p) => p.title === 'Other school only'));
    });
    await check('a teacher cannot list passages for a subject they do not teach', () => assert.rejects(P.listPassages(teacher, a.maths.id), /not assigned/));

    // ── edit ───────────────────────────────────────────────────────────────
    await check('title, instruction and text can be corrected while nothing is handed in', async () => {
      await P.editPassage(teacher, pass.id, { title: 'The Busy Village Market', instructions: 'Read carefully, then answer questions 1 to 3.', body: body + ' Soon the whole square is full.' });
      const [row] = await db.select().from(schema.passages).where(eq(schema.passages.id, pass.id));
      assert.equal(row!.title, 'The Busy Village Market');
      assert.match(row!.body, /whole square is full/);
      assert.equal(row!.instructions, 'Read carefully, then answer questions 1 to 3.');
    });
    await check('editing leaves the questions on the passage untouched', async () => {
      const rows = await db.select().from(schema.questions).where(eq(schema.questions.passageId, pass.id));
      assert.equal(rows.length, 3);
    });
    await check('an edit that clashes with another passage title is refused', async () => {
      await assert.rejects(P.editPassage(teacher, pass.id, { title: 'No instruction' }), /already has that title/);
    });
    await check('a bad edit changes NOTHING (title too short)', async () => {
      await assert.rejects(P.editPassage(teacher, pass.id, { title: 'x', body: 'Replacement text that is long enough to be valid.' }), /title/);
      const [row] = await db.select().from(schema.passages).where(eq(schema.passages.id, pass.id));
      assert.equal(row!.title, 'The Busy Village Market');
      assert.doesNotMatch(row!.body, /Replacement text/);
    });
    await check('an unassigned teacher cannot edit it', () => assert.rejects(P.editPassage(unassigned, pass.id, { title: 'Hijacked' }), /not assigned/));
    await check('another school cannot edit it', () => assert.rejects(P.editPassage(b.actors.principal!, pass.id, { title: 'Hijacked' }), /not found/));

    // ── delete preview and delete ───────────────────────────────────────────
    await check('the delete preview says how many questions would go', async () => {
      const pv = await P.passageDeletePreview(teacher, pass.id);
      assert.equal(pv.questions, 3); assert.equal(pv.allowed, true); assert.equal(pv.reason, null);
    });
    await check('the preview removes nothing', async () => {
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.passageId, pass.id))).length, 3);
    });
    await check('another school cannot preview or delete it', async () => {
      await assert.rejects(P.passageDeletePreview(b.actors.principal!, pass.id), /not found/);
      await assert.rejects(P.deletePassageWithQuestions(b.actors.principal!, pass.id), /not found/);
    });
    await check('an unassigned teacher cannot delete it', () => assert.rejects(P.deletePassageWithQuestions(unassigned, pass.id), /not assigned/));

    // locking: once handed in, the passage and its questions are protected
    await check('once the set is handed in, the passage can no longer be edited or deleted', async () => {
      await db.update(schema.questionSets).set({ status: 'submitted' }).where(eq(schema.questionSets.id, set.id));
      const pv = await P.passageDeletePreview(teacher, pass.id);
      assert.equal(pv.allowed, false); assert.match(pv.reason!, /handed in/);
      await assert.rejects(P.deletePassageWithQuestions(teacher, pass.id), /cannot be deleted/);
      await assert.rejects(P.editPassage(teacher, pass.id, { title: 'Too late' }), /no longer be changed/);
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.passageId, pass.id))).length, 3, 'nothing was removed');
      await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.id, set.id));
    });
    await check('a question already in an exam paper protects its passage', async () => {
      const [series] = await db.insert(schema.examSeries).values({ schoolId: a.schoolId, sessionId: a.session.id, termId: a.term.id, title: 'Paper series', seriesType: 'practice', status: 'published' }).returning();
      const [paper] = await db.insert(schema.examPapers).values({ schoolId: a.schoolId, seriesId: series!.id, subjectId: a.english.id, durationSeconds: 600, questionCount: 1, status: 'published' }).returning();
      await db.insert(schema.paperQuestions).values({ schoolId: a.schoolId, paperId: paper!.id, questionId: q[0]!, sortOrder: 0 });
      const pv = await P.passageDeletePreview(teacher, pass.id);
      assert.equal(pv.allowed, false); assert.match(pv.reason!, /exam paper/);
      await assert.rejects(P.deletePassageWithQuestions(teacher, pass.id), /cannot be deleted/);
      await db.delete(schema.examPapers).where(eq(schema.examPapers.id, paper!.id));
      await db.delete(schema.examSeries).where(eq(schema.examSeries.id, series!.id));
    });
    await check('another teacher\'s question on the passage protects it from a different teacher', async () => {
      const otherSet = await db.insert(schema.questionSets).values({ schoolId: a.schoolId, sessionId: a.session.id, termId: a.term.id, subjectId: a.english.id, levelId: a.level.id, examType: 'objective', seriesId: 555, teacherId: principal.staffId! }).returning();
      const [oq] = await db.insert(schema.questions).values({ schoolId: a.schoolId, questionSetId: otherSet[0]!.id, questionText: 'Principal wrote this one?', passageId: pass.id, passagePosition: 3 }).returning();
      const pv = await P.passageDeletePreview(teacher, pass.id);
      assert.equal(pv.allowed, false); assert.match(pv.reason!, /another teacher/);
      await db.delete(schema.questions).where(eq(schema.questions.id, oq!.id));
      await db.delete(schema.questionSets).where(eq(schema.questionSets.id, otherSet[0]!.id));
    });

    // finally, the allowed delete
    await check('deleting removes the passage AND all its questions, and reports the number', async () => {
      const r = await P.deletePassageWithQuestions(teacher, pass.id);
      assert.equal(r.deletedQuestions, 3);
      assert.equal((await db.select().from(schema.passages).where(eq(schema.passages.id, pass.id))).length, 0);
      assert.equal((await db.select().from(schema.questions).where(inArray(schema.questions.id, q))).length, 0);
    });
    await check('deleting did not touch the other passages or the other school', async () => {
      assert.ok((await db.select().from(schema.passages).where(eq(schema.passages.schoolId, a.schoolId))).length >= 2);
      assert.equal((await db.select().from(schema.passages).where(eq(schema.passages.schoolId, b.schoolId))).length, 2, 'both of the other school\'s passages survive');
    });
    await check('a passage with no questions deletes cleanly and says 0', async () => {
      const p = await P.createPassage(teacher, { subjectId: a.english.id, title: 'Empty one', body }) as { id: number };
      const pv = await P.passageDeletePreview(teacher, p.id);
      assert.equal(pv.questions, 0); assert.equal(pv.allowed, true);
      assert.equal((await P.deletePassageWithQuestions(teacher, p.id)).deletedQuestions, 0);
    });
    await check('every change is in the audit log', async () => {
      const acts = (await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, a.schoolId))).map((r) => r.action);
      for (const want of ['passage.created', 'passage.edited', 'passage.deleted']) assert.ok(acts.includes(want), want + ' missing');
    });

    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of ids) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
