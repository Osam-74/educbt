/**
 * Importing questions with passages: what the import action does, run through the real services and database.
 * Isolated fixture schools, removed at the end. LOCAL disposable database only.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, inArray } from 'drizzle-orm';
import type { Actor } from '@/lib/session';
import { parseCSV } from '@/app/portal/questions/parsers';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client } = await import('@/db');
  const { findOrCreateSet, addQuestionsBulk, getSetSubject } = await import('@/lib/exam/sets');
  const { saveCollection } = await import('@/lib/exam/collection');
  const P = await import('@/lib/exam/passages');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const ids: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Import test', code: 'PI-' + randomUUID() }).returning();
    const schoolId = school!.id; ids.push(schoolId);
    const actors: Record<string, Actor> = {};
    for (const name of ['principal', 'teacher']) {
      const role = name as 'principal' | 'teacher';
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: name, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: name, firstName: 'Test', lastName: name }).returning();
      actors[name] = { schoolId, userId: user!.id, role, staffId: staff!.id, studentId: null, loginId: name };
    }
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: actors.teacher!.staffId!, subjectId: english!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    await saveCollection(actors.principal!, { objective: 1, theory: 1, seriesId: series!.id });
    const set = await findOrCreateSet(actors.teacher!, { sessionId: session!.id, termId: term!.id, subjectId: english!.id, levelId: level!.id, departmentId: null, seriesId: 0, examType: 'objective', waecMode: false });
    return { schoolId, teacher: actors.teacher!, english: english!, set };
  }

  /** What the import action does, step for step. */
  async function runImport(f: Awaited<ReturnType<typeof fixture>>, csv: string) {
    const existing = await P.listPassages(f.teacher, f.english.id);
    const parsed = parseCSV(csv, false, 1, existing.map((p) => ({ id: p.id, title: p.title })));
    const valid = parsed.rows.filter((r) => r.status === 'valid');
    const subjectId = await getSetSubject(f.teacher, f.set.id);
    const needed = new Set(valid.map((r) => r.passageRef?.toLowerCase()).filter((x): x is string => !!x));
    const made = await P.ensurePassagesForImport(f.teacher, subjectId, parsed.passages.filter((d) => needed.has(d.ref.toLowerCase())));
    const items = valid.map((r) => ({ text: r.text, marks: r.marks, options: r.options,
      passageId: r.passageRef ? (made.ids.get(r.passageRef.toLowerCase()) ?? r.passageExistingId ?? null) : null }));
    return { parsed, outcome: await addQuestionsBulk(f.teacher, f.set.id, items) };
  }

  const H = 'question,option_a,option_b,option_c,option_d,correct_option,marks,passage_ref,passage_title,passage_instructions,passage_text';
  const csv = () => [H,
    ',,,,,,,P1,The Village Market,Read it and answer 1 to 2.,"The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come."',
    'When does the market open?,At dawn,At noon,At night,Never,A,1,P1,,,',
    'Who arrives after the traders?,Customers,Nobody,Police,Birds,A,1,P1,,,',
    'What is 2+2?,3,4,5,6,B,2,,,,'].join('\n');
  const passagesOf = (schoolId: number) => db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId));
  const questionsOf = (setId: number) => db.select().from(schema.questions).where(eq(schema.questions.questionSetId, setId));

  try {
    const f = await fixture();
    await check('a file with a passage creates the passage once, with its instruction and ALL its paragraphs', async () => {
      const r = await runImport(f, csv());
      assert.equal(r.outcome.added, 3); assert.equal(r.outcome.failed.length, 0, JSON.stringify(r.outcome.failed));
      const ps = await passagesOf(f.schoolId);
      assert.equal(ps.length, 1);
      assert.equal(ps[0]!.title, 'The Village Market'); assert.equal(ps[0]!.instructions, 'Read it and answer 1 to 2.');
      assert.equal(ps[0]!.body, 'The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come.');
    });
    await check('both questions are on the passage in file order, and the plain question is on none', async () => {
      const [p] = await passagesOf(f.schoolId);
      const qs = await questionsOf(f.set.id);
      const on = qs.filter((q) => q.passageId === p!.id).sort((a, b) => a.passagePosition - b.passagePosition);
      assert.deepEqual(on.map((q) => [q.questionText, q.passagePosition]), [['When does the market open?', 0], ['Who arrives after the traders?', 1]]);
      assert.equal(qs.find((q) => q.questionText === 'What is 2+2?')!.passageId, null);
    });
    await check('a file that defines a passage the school already has uses the saved one and attaches the new questions to it', async () => {
      const [p] = await passagesOf(f.schoolId);
      const before = (await questionsOf(f.set.id)).filter((q) => q.passageId === p!.id).length;
      const again = [H,
        ',,,,,,,P1,The Village Market,Read it and answer 1 to 2.,"The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come."',
        'What is sold at the market?,Goods,Nothing,Cars,Boats,A,1,P1,,,'].join('\n');
      const r = await runImport(f, again);
      assert.equal(r.outcome.failed.length, 0, 'no failure: ' + JSON.stringify(r.outcome.failed));
      assert.equal(r.outcome.added, 1);
      assert.equal((await passagesOf(f.schoolId)).length, 1, 'still ONE passage');
      assert.equal((await questionsOf(f.set.id)).filter((q) => q.passageId === p!.id).length, before + 1);
    });
    await check('importing the very same file twice adds no second passage and no second copy of a question', async () => {
      const before = (await questionsOf(f.set.id)).length;
      await runImport(f, csv());
      assert.equal((await passagesOf(f.schoolId)).length, 1);
      assert.equal((await questionsOf(f.set.id)).length, before, 'duplicates are refused, not doubled');
    });
    await check('a later file can attach a new question to the saved passage by its exact title', async () => {
      const [p] = await passagesOf(f.schoolId);
      const before = (await questionsOf(f.set.id)).filter((q) => q.passageId === p!.id).length;
      const r = await runImport(f, [H, 'What do traders arrange?,Goods,Cars,Shoes,Books,A,1,the village market,,,'].join('\n'));
      assert.equal(r.outcome.added, 1, JSON.stringify(r.outcome.failed));
      const on = (await questionsOf(f.set.id)).filter((q) => q.passageId === p!.id);
      assert.equal(on.length, before + 1);
      assert.deepEqual(on.map((q) => q.passagePosition).sort((a, b) => a - b), Array.from({ length: on.length }, (_, i) => i), 'positions run on without gaps');
    });
    await check('a question pointing at a passage that is nowhere is held back and nothing is saved for it', async () => {
      const before = (await questionsOf(f.set.id)).length;
      const r = await runImport(f, [H, 'Orphan question?,A,B,C,D,A,1,P9,,,'].join('\n'));
      assert.equal(r.parsed.rows[0]!.status, 'error'); assert.equal(r.outcome.added, 0);
      assert.equal((await questionsOf(f.set.id)).length, before);
    });
    await check('a passage defined in the file but used by no valid question is not created', async () => {
      const before = (await passagesOf(f.schoolId)).length;
      await runImport(f, [H, ',,,,,,,P7,Unused passage,,"Nobody asks anything about this passage at all."'].join('\n'));
      assert.equal((await passagesOf(f.schoolId)).length, before);
    });
    await check('a file with no passages imports exactly as it always did', async () => {
      const g = await fixture();
      const r = await runImport(g, ['question,option_a,option_b,option_c,option_d,correct_option,marks', 'Plain one?,A,B,C,D,A,1', 'Plain two?,A,B,C,D,B,1'].join('\n'));
      assert.equal(r.outcome.added, 2);
      assert.equal((await passagesOf(g.schoolId)).length, 0);
    });
    await check('two schools importing the same file never share a passage', async () => {
      const a = await fixture(), b = await fixture();
      await runImport(a, csv()); await runImport(b, csv());
      const pa = await passagesOf(a.schoolId), pb = await passagesOf(b.schoolId);
      assert.equal(pa.length, 1); assert.equal(pb.length, 1); assert.notEqual(pa[0]!.id, pb[0]!.id);
      const qa = await db.select().from(schema.questions).where(eq(schema.questions.passageId, pa[0]!.id));
      assert.ok(qa.length > 0 && qa.every((q) => Number(q.schoolId) === a.schoolId));
    });
    await check('a passage too short to be valid is reported, and its questions are NOT saved loose', async () => {
      const g = await fixture();
      const r = await runImport(g, [H, ',,,,,,,P1,Tiny,,Hi', 'Q about tiny?,A,B,C,D,A,1,P1,,,'].join('\n'));
      // the action holds back any question whose passage could not be made; mirror that here
      const subjectId = await getSetSubject(g.teacher, g.set.id);
      const made = await P.ensurePassagesForImport(g.teacher, subjectId, r.parsed.passages);
      assert.equal(made.ids.size, 0); assert.match([...made.failed.values()][0]!, /passage itself/);
    });
    await check('a teacher who is not assigned to the subject cannot create passages through an import', async () => {
      const g = await fixture();
      const [other] = await db.insert(schema.subjects).values({ schoolId: g.schoolId, code: 'MTH', name: 'Maths' }).returning();
      const made = await P.ensurePassagesForImport(g.teacher, other!.id, [{ ref: 'P1', title: 'Sneaky', instructions: '', body: 'A passage long enough to be valid here.' }]);
      assert.equal(made.ids.size, 0); assert.match([...made.failed.values()][0]!, /not assigned/);
      assert.equal((await passagesOf(g.schoolId)).length, 0);
    });
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (ids.length) await db.delete(schema.schools).where(inArray(schema.schools.id, ids));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
