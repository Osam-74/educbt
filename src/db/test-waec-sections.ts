/**
 * WAEC sections on real questions: what may be chosen, who may change it, and when it locks.
 * Isolated fixture school, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { findOrCreateSet, addQuestion, updateQuestion } = await import('@/lib/exam/sets');
  const { saveCollection } = await import('@/lib/exam/collection');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  let schoolId = 0, checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  const opts = [{ text: 'Yes', isCorrect: true }, { text: 'No', isCorrect: false }];

  try {
    const [school] = await db.insert(schema.schools).values({ name: 'WAEC sections', code: 'WS-' + randomUUID() }).returning(); schoolId = school!.id;
    const actors: Record<string, Actor> = {};
    for (const name of ['principal', 'teacher', 'other']) {
      const role = name === 'principal' ? 'principal' : 'teacher';
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: name, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: name, firstName: 'T', lastName: name }).returning();
      actors[name] = { schoolId, userId: user!.id, role, staffId: staff!.id, studentId: null, loginId: name };
    }
    const { principal, teacher, other } = actors as Record<'principal' | 'teacher' | 'other', Actor>;
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS2', stage: 'senior' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS2 A' }).returning();
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    for (const a of [teacher, other]) await db.insert(schema.staffAssignments).values({ schoolId, staffId: a.staffId!, subjectId: english!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    await saveCollection(principal, { objective: 1, theory: 1, seriesId: series!.id });
    const scope = (examType: 'objective' | 'theory', waecMode: boolean) => ({ sessionId: session!.id, termId: term!.id, subjectId: english!.id, levelId: level!.id, departmentId: null, seriesId: 0, examType, waecMode, deliveryMode: 'cbt' as const });
    const waecObj = await findOrCreateSet(teacher, scope('objective', true));
    const waecTheory = await findOrCreateSet(teacher, scope('theory', true));
    const plain = await findOrCreateSet(teacher, scope('objective', false));
    const sectionOf = async (id: number) => (await db.select().from(schema.questions).where(eq(schema.questions.id, id)))[0]!.section;
    const [shared] = await db.insert(schema.passages).values({ schoolId, subjectId: english!.id, title: 'Shared cloze passage', body: 'A cloze passage with blanks that is long enough to be valid here.' }).returning();
    const add = async (set: { id: number }, text: string, section = '', passageId?: number) => Number(((await addQuestion(teacher, set.id, { text, marks: 1, options: opts, section, ...(passageId ? { passageId } : {}) })) as { id: number }).id);

    await check('a question is saved with the section the teacher chose, by its real key', async () => { assert.equal(await sectionOf(await add(waecObj, 'Pick the antonym of "brave"?', 'paper1:antonyms')), 'paper1:antonyms'); });
    await check('a question saved with no section keeps none (it is not placed yet)', async () => { assert.equal(await sectionOf(await add(waecObj, 'Unplaced question one?')), ''); });
    await check('a made-up section is refused and nothing is saved', async () => {
      const before = (await db.select().from(schema.questions).where(eq(schema.questions.questionSetId, waecObj.id))).length;
      await assert.rejects(addQuestion(teacher, waecObj.id, { text: 'Typo question?', marks: 1, options: opts, section: 'paper1:antonym' }), /not a section/);
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.questionSetId, waecObj.id))).length, before);
    });
    await check('a theory section on an objective set is refused', async () => { await assert.rejects(addQuestion(teacher, waecObj.id, { text: 'Wrong type?', marks: 1, options: opts, section: 'paper2:essay' }), /theory questions/); });
    await check('any section on an ordinary (non-WAEC) set is refused', async () => { await assert.rejects(addQuestion(teacher, plain.id, { text: 'Ordinary set question?', marks: 1, options: opts, section: 'paper1:grammar' }), /WAEC-structured/); });
    await check('a theory question takes a paper 2 section', async () => {
      const r = await addQuestion(teacher, waecTheory.id, { text: 'Write a formal letter to your principal.', marks: 10, section: 'paper2:essay' }) as { id: number };
      assert.equal(await sectionOf(Number(r.id)), 'paper2:essay');
    });

    // ── change a section ────────────────────────────────────────────────
    let q = 0;
    await check('a teacher can move their question to another section while it is a draft', async () => {
      q = await add(waecObj, 'Choose the best synonym for "rapid"?', 'paper1:antonyms');
      await updateQuestion(teacher, q, { section: 'paper1:synonyms' });
      assert.equal(await sectionOf(q), 'paper1:synonyms');
    });
    await check('a question that has no section yet can be given one', async () => {
      const u = await add(waecObj, 'Unplaced question two?');
      await updateQuestion(teacher, u, { section: 'paper1:grammar' }); assert.equal(await sectionOf(u), 'paper1:grammar');
    });
    await check('a section typed with stray spaces is stored clean, so it still matches its key later', async () => {
      const sp = await add(waecObj, 'Spaced section question?');
      await updateQuestion(teacher, sp, { section: '  paper1:idioms  ' });
      assert.equal(await sectionOf(sp), 'paper1:idioms');
      const sp2 = Number(((await addQuestion(teacher, waecObj.id, { text: 'Spaced on add question?', marks: 1, options: opts, section: ' paper1:rhymes'.replace('paper1', 'paper3') + ' ' })) as { id: number }).id);
      assert.equal(await sectionOf(sp2), 'paper3:rhymes');
    });
    await check('a section can be cleared again', async () => { await updateQuestion(teacher, q, { section: '' }); assert.equal(await sectionOf(q), ''); await updateQuestion(teacher, q, { section: 'paper1:synonyms' }); });
    await check('the change is checked just like a new question: a bad section is refused and the old one stays', async () => {
      await assert.rejects(updateQuestion(teacher, q, { section: 'paper9:nope' }), /not a section/);
      await assert.rejects(updateQuestion(teacher, q, { section: 'paper2:essay' }), /theory questions/);
      assert.equal(await sectionOf(q), 'paper1:synonyms');
    });
    await check('another teacher cannot change it', async () => { await assert.rejects(updateQuestion(other, q, { section: 'paper1:idioms' }), /another teacher/); assert.equal(await sectionOf(q), 'paper1:synonyms'); });
    await check('a question in a set that is not WAEC-structured cannot be given a section', async () => {
      const p = await add(plain, 'Ordinary question to edit?'); await assert.rejects(updateQuestion(teacher, p, { section: 'paper1:grammar' }), /WAEC-structured/);
    });

    // ── the lock ────────────────────────────────────────────────────────
    await check('once the question is APPROVED its section is locked, with the reason', async () => {
      await db.update(schema.questions).set({ approvalStatus: 'approved' }).where(eq(schema.questions.id, q));
      await assert.rejects(updateQuestion(teacher, q, { section: 'paper1:idioms' }), /approved, so its section can no longer be changed/);
      assert.equal(await sectionOf(q), 'paper1:synonyms');
    });
    await check('re-saving the SAME section on an approved question is harmless (not a change)', async () => { await updateQuestion(teacher, q, { section: 'paper1:synonyms' }); });
    await check('a question sent back for revision is open again', async () => {
      await db.update(schema.questions).set({ approvalStatus: 'revision' }).where(eq(schema.questions.id, q));
      await updateQuestion(teacher, q, { section: 'paper1:idioms' }); assert.equal(await sectionOf(q), 'paper1:idioms');
    });
    await check('a question that is merely pending stays editable', async () => {
      await db.update(schema.questions).set({ approvalStatus: 'pending' }).where(eq(schema.questions.id, q));
      await updateQuestion(teacher, q, { section: 'paper1:grammar' });
    });
    await check('once the SET is handed in, nothing can be changed', async () => {
      await db.update(schema.questionSets).set({ status: 'submitted' }).where(eq(schema.questionSets.id, waecObj.id));
      await assert.rejects(updateQuestion(teacher, q, { section: 'paper1:cloze', passageId: shared!.id }), /submitted and can no longer be edited/);
      await assert.rejects(updateQuestion(teacher, q, { text: 'Sneaky rewording of the question?' }), /submitted and can no longer be edited/);
      await db.update(schema.questionSets).set({ status: 'returned' }).where(eq(schema.questionSets.id, waecObj.id));
    });
    await check('a set the office sent back (returned) can be edited again', async () => { await updateQuestion(teacher, q, { section: 'paper1:cloze', passageId: shared!.id }); assert.equal(await sectionOf(q), 'paper1:cloze'); });
    await check('a question students have already answered cannot be changed at all', async () => {
      const a = await add(waecObj, 'Answered question?', 'paper1:rhymes'.replace('paper1', 'paper3'));
      const [stu] = await db.insert(schema.students).values({ schoolId, admissionNumber: 'A' + randomUUID().slice(0, 6), firstName: 'S', lastName: 'T' } as never).returning();
      const [paperSeries] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'Answered series', seriesType: 'practice', status: 'published' }).returning();
      const [paper] = await db.insert(schema.examPapers).values({ schoolId, seriesId: paperSeries!.id, subjectId: english!.id, durationSeconds: 600, questionCount: 1, status: 'published' }).returning();
      const [att] = await db.insert(schema.attempts).values({ schoolId, paperId: paper!.id, studentId: stu!.id, expiresAt: new Date(Date.now() + 600000), questionOrder: [a] } as never).returning();
      await db.insert(schema.attemptAnswers).values({ schoolId, attemptId: att!.id, questionId: a } as never);
      await assert.rejects(updateQuestion(teacher, a, { section: 'paper3:vowels' }), /already answered/);
    });

    // ── words and marks ─────────────────────────────────────────────────
    await check('rewording a question sends it back to pending for the reviewer', async () => {
      const w = await add(waecObj, 'Original wording of the question?', 'paper1:grammar');
      await db.update(schema.questions).set({ approvalStatus: 'approved' }).where(eq(schema.questions.id, w));
      await updateQuestion(teacher, w, { text: 'A better wording of the question?' });
      const [row] = await db.select().from(schema.questions).where(eq(schema.questions.id, w));
      assert.equal(row!.questionText, 'A better wording of the question?'); assert.equal(row!.approvalStatus, 'pending');
    });
    await check('the loophole is shut: rewording an approved question does NOT unlock its section in the same call', async () => {
      const w = await add(waecObj, 'Loophole question text?', 'paper1:grammar');
      await db.update(schema.questions).set({ approvalStatus: 'approved' }).where(eq(schema.questions.id, w));
      await assert.rejects(updateQuestion(teacher, w, { text: 'Loophole question reworded?', section: 'paper1:idioms' }), /approved, so its section/);
      const [row] = await db.select().from(schema.questions).where(eq(schema.questions.id, w));
      assert.equal(row!.questionText, 'Loophole question text?', 'nothing was changed'); assert.equal(row!.section, 'paper1:grammar');
    });
    await check('a reworded question cannot duplicate another in the set', async () => {
      const a = await add(waecObj, 'Duplicate target question?'); const b = await add(waecObj, 'Another different question?');
      await assert.rejects(updateQuestion(teacher, b, { text: 'duplicate target question?' }), /already exists/);
      assert.ok(a);
    });
    await check('instructions and the marking guide can be changed without touching approval', async () => {
      const t = Number(((await addQuestion(teacher, waecTheory.id, { text: 'Write a speech on honesty.', marks: 10, section: 'paper2:essay' })) as { id: number }).id);
      await db.update(schema.questions).set({ approvalStatus: 'approved' }).where(eq(schema.questions.id, t));
      await updateQuestion(teacher, t, { markingGuide: 'Award 5 for content and 5 for expression.', instructions: 'Write about 300 words.' });
      const [row] = await db.select().from(schema.questions).where(eq(schema.questions.id, t));
      assert.equal(row!.markingGuide, 'Award 5 for content and 5 for expression.'); assert.equal(row!.approvalStatus, 'approved');
    });
    await check('a question can be attached to a passage of its own subject, and a foreign passage is refused', async () => {
      const [mine] = await db.insert(schema.passages).values({ schoolId, subjectId: english!.id, title: 'Sections passage', body: 'A passage that is long enough to be valid here.' }).returning();
      const c = await add(waecObj, 'Question for a passage?', 'paper1:grammar');
      await updateQuestion(teacher, c, { passageId: mine!.id });
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.id, c)))[0]!.passageId, mine!.id);
      await assert.rejects(updateQuestion(teacher, c, { passageId: 99999999 }), /passage/);
    });
    await check('a NEW cloze, comprehension or summary question without a passage is refused, and nothing is saved', async () => {
      const before = (await db.select().from(schema.questions).where(eq(schema.questions.questionSetId, waecObj.id))).length;
      await assert.rejects(addQuestion(teacher, waecObj.id, { text: 'A gap with no passage at all?', marks: 1, options: opts, section: 'paper1:cloze' }), /written about a passage/);
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.questionSetId, waecObj.id))).length, before);
      await assert.rejects(addQuestion(teacher, waecTheory.id, { text: 'Answer the questions on the text.', marks: 5, section: 'paper2:comprehension' }), /written about a passage/);
      await assert.rejects(addQuestion(teacher, waecTheory.id, { text: 'Summarise the text.', marks: 5, section: 'paper2:summary' }), /written about a passage/);
    });
    await check('the same questions are accepted once they carry a passage', async () => {
      const id = await add(waecObj, 'Gap 1 with its passage?', 'paper1:cloze', shared!.id);
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.id, id)))[0]!.passageId, shared!.id);
    });
    await check('sections that need no passage are unaffected', async () => { await add(waecObj, 'A plain antonym, no passage needed?', 'paper1:antonyms'); await add(waecObj, 'No section yet, no passage needed?'); });
    await check('moving a question INTO a passage section needs a passage; with one it works', async () => {
      const m = await add(waecObj, 'Question to move into cloze?', 'paper1:grammar');
      await assert.rejects(updateQuestion(teacher, m, { section: 'paper1:cloze' }), /written about a passage/);
      assert.equal(await sectionOf(m), 'paper1:grammar');
      await updateQuestion(teacher, m, { section: 'paper1:cloze', passageId: shared!.id }); assert.equal(await sectionOf(m), 'paper1:cloze');
    });
    await check('the passage cannot be taken OFF a question that sits in a passage section', async () => {
      const m = await add(waecObj, 'Cloze gap that must keep its passage?', 'paper1:cloze', shared!.id);
      await assert.rejects(updateQuestion(teacher, m, { passageId: null }), /written about a passage/);
      assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.id, m)))[0]!.passageId, shared!.id);
    });
    await check('a question ALREADY in a passage section without a passage (older data) can still be edited, never re-judged', async () => {
      const old = await add(waecObj, 'Older cloze gap saved before this rule?', 'paper1:grammar');
      await db.update(schema.questions).set({ section: 'paper1:cloze' }).where(eq(schema.questions.id, old));
      await updateQuestion(teacher, old, { instructions: 'Fill the gap.' });
      assert.equal(await sectionOf(old), 'paper1:cloze');
    });
    await check('a change is written to the audit trail', async () => {
      assert.ok((await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, schoolId))).some((r) => r.action === 'question.updated'));
    });
    await check('a question from another school is not found', async () => {
      const [other2] = await db.insert(schema.schools).values({ name: 'Elsewhere', code: 'WX-' + randomUUID() }).returning();
      try { await assert.rejects(updateQuestion(teacher, 987654321, { section: 'paper1:grammar' }), /not found/); }
      finally { await db.delete(schema.schools).where(eq(schema.schools.id, other2!.id)); }
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (schoolId) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
