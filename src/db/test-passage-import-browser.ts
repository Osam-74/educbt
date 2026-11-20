/**
 * Uploading a real CSV file with a comprehension passage, in a real browser, then looking at what was saved.
 * LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-passage-import-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const base = new URL(process.env.CA_TEST_HTTP_URL ?? ''); assert(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert(process.env.QUESTION_BROWSER_MODULE, 'browser runtime required');
  const { schema, client } = await import('@/db');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  let schoolId = 0, checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  try {
    const [school] = await db.insert(schema.schools).values({ name: 'Import UI', code: 'IU-' + randomUUID() }).returning(); schoolId = school!.id;
    const [user] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 'teacher', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role: 'teacher', staffNumber: 't', firstName: 'Test', lastName: 'Teacher' }).returning();
    const [pUser] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'principal', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [pStaff] = await db.insert(schema.staff).values({ schoolId, userId: pUser!.id, role: 'principal', staffNumber: 'p', firstName: 'Test', lastName: 'Principal' }).returning();
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: staff!.id, subjectId: english!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    const { saveCollection } = await import('@/lib/exam/collection');
    await saveCollection({ schoolId, userId: pUser!.id, role: 'principal', staffId: pStaff!.id, studentId: null, loginId: 'principal' }, { objective: 1, theory: 1, seriesId: series!.id });

    const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: user!.id, expiresAt: new Date(Date.now() + 1800000) });

    const H = 'question,option_a,option_b,option_c,option_d,correct_option,marks,passage_ref,passage_title,passage_instructions,passage_text';
    // Saved the way Excel on Windows saves it: byte-order mark, \r\n everywhere, quoted passage with paragraph breaks
    const file = '\uFEFF' + [H,
      ',,,,,,,P1,The Village Market,Read it and answer 1 to 2.,"The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come."',
      'When does the market open?,At dawn,At noon,At night,Never,A,1,P1,,,',
      'Who arrives after the traders?,Customers,Nobody,Police,Birds,A,1,P1,,,',
      'What is 2+2?,3,4,5,6,B,2,,,,',
      'Orphan question?,A,B,C,D,A,1,P9,,,'].join('\r\n');

    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await context.newPage(); const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      await page.goto(new URL('/portal/questions', base).href, { waitUntil: 'networkidle' });
      await page.locator('#qs-subject').selectOption(String(english!.id));
      await page.locator('#qs-class').selectOption(`${level!.id}:`);
      await page.waitForURL(/setId=/);
      await page.locator('#qs-method').selectOption('csv');

      await check('the import page explains the passage columns', async () => {
        await page.getByText('passage_ref', { exact: false }).first().waitFor();
        await page.getByText('exact title of a passage you have already saved').waitFor();
      });
      await check('uploading the file shows each question with its passage, and holds back the orphan', async () => {
        await page.locator('input[type=file]').setInputFiles({ name: 'passage.csv', mimeType: 'text/csv', buffer: Buffer.from(file, 'utf8') });
        await page.getByText('When does the market open?').waitFor();
        const rows = page.locator('.qs-staging tbody tr');
        assert.equal(await rows.count(), 4, 'the passage row is not listed as a question');
        const village = rows.filter({ hasText: 'The Village Market' });
        assert.equal(await village.count(), 2, 'two questions show their passage title');
        const orphan = rows.filter({ hasText: 'Orphan question?' });
        assert.match((await orphan.textContent()) ?? '', /has no passage/);
        assert.equal(await orphan.locator('input[type=checkbox]').isDisabled(), true, 'the orphan cannot be ticked');
        assert.equal(await page.getByRole('button', { name: 'Add 3 questions' }).count(), 1);
      });
      await check('adding saves one passage with every paragraph and no stray carriage returns', async () => {
        await page.getByRole('button', { name: 'Add 3 questions' }).click();
        await page.getByText('Added 3 questions.').waitFor();
        const ps = await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId));
        assert.equal(ps.length, 1);
        assert.equal(ps[0]!.body, 'The market opens at dawn.\nTraders arrange their goods.\n\nThen the customers come.');
        assert.equal(ps[0]!.instructions, 'Read it and answer 1 to 2.');
      });
      await check('the questions are linked in order, and the plain one is not', async () => {
        const [p] = await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId));
        const qs = await db.select().from(schema.questions).where(eq(schema.questions.schoolId, schoolId));
        const on = qs.filter((q) => q.passageId === p!.id).sort((a, b) => a.passagePosition - b.passagePosition);
        assert.deepEqual(on.map((q) => q.questionText), ['When does the market open?', 'Who arrives after the traders?']);
        assert.equal(qs.find((q) => q.questionText === 'What is 2+2?')!.passageId, null);
        assert.equal(qs.find((q) => q.questionText === 'Orphan question?'), undefined, 'the orphan was never saved');
      });
      await check('uploading the same file again does not duplicate the passage or the questions', async () => {
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('#qs-method').selectOption('csv');
        await page.locator('input[type=file]').setInputFiles({ name: 'passage.csv', mimeType: 'text/csv', buffer: Buffer.from(file, 'utf8') });
        await page.getByText('When does the market open?').waitFor();
        await page.getByRole('button', { name: 'Add 3 questions' }).click();
        await page.getByText(/could not be saved/).waitFor();
        assert.equal((await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId))).length, 1);
        assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.schoolId, schoolId))).length, 3);
      });
      await check('the downloaded template is a working example', async () => {
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('#qs-method').selectOption('csv');
        const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Template' }).click()]);
        const text = await (await import('node:fs/promises')).readFile(await download.path(), 'utf8');
        assert.ok(text.includes('passage_ref') && text.includes('The Village Market'));
        await page.locator('input[type=file]').setInputFiles({ name: 'template.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') });
        await page.locator('.qs-staging').waitFor();
        assert.equal(await page.locator('.qs-staging tbody tr.qs-row--error').count(), 0, 'every row in the template is valid');
      });
      assert.deepEqual(errors, [], 'no script errors in the page');
    } finally { await browser.close(); }
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (schoolId) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
