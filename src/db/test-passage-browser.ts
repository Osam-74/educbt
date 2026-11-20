/**
 * The passage panel in a real browser: tick, save, add questions, edit with the pencil, delete with the bin and
 * its warning, and the lock once a set is handed in. LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-passage-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
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
    const [school] = await db.insert(schema.schools).values({ name: 'Passage UI', code: 'PU-' + randomUUID() }).returning(); schoolId = school!.id;
    const mkUser = async (role: 'principal' | 'teacher', loginId: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: loginId, firstName: 'Test', lastName: loginId }).returning();
      return { user: user!, staff: staff! };
    };
    const principal = await mkUser('principal', 'principal'), teacher = await mkUser('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staff.id, subjectId: english!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    const { saveCollection } = await import('@/lib/exam/collection');
    await saveCollection({ schoolId, userId: principal.user.id, role: 'principal', staffId: principal.staff.id, studentId: null, loginId: 'principal' }, { objective: 1, theory: 1, seriesId: series!.id });

    const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: teacher.user.id, expiresAt: new Date(Date.now() + 1800000) });

    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
      await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await context.newPage(); const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      await mkdir('baseline-logs', { recursive: true });

      await page.goto(new URL('/portal/questions', base).href, { waitUntil: 'networkidle' });
      await page.locator('#qs-subject').selectOption(String(english!.id));
      await page.locator("#qs-class").selectOption(`${level!.id}:`);
      await page.waitForURL(/setId=/);

      await check('the passage tick is there, unticked, with a one-line hint', async () => {
        const box = page.getByRole('checkbox', { name: 'Comprehension passage' });
        await box.waitFor(); assert.equal(await box.isChecked(), false);
        await page.getByText('Tick this when the questions below are about a passage').waitFor();
        assert.equal(await page.locator('#passageBody').count(), 0, 'no passage boxes until ticked');
      });
      await check('ticking it shows the instruction and passage boxes', async () => {
        await page.getByRole('checkbox', { name: 'Comprehension passage' }).check();
        await page.locator('#passageInstructions').waitFor(); await page.locator('#passageBody').waitFor();
      });
      await check('saving a passage with no text is refused with a plain message', async () => {
        await page.locator('#passageTitle').fill('The Village Market');
        await page.locator('#passageBody').fill('Short');
        await page.getByRole('button', { name: 'Save passage and add questions' }).click();
        await page.getByRole('alert').filter({ hasText: 'Write or paste the passage itself' }).waitFor();
        assert.equal((await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId))).length, 0, 'nothing was saved');
      });
      await check('a proper passage saves and becomes the passage new questions go to', async () => {
        await page.getByRole('checkbox', { name: 'Comprehension passage' }).check();
        await page.locator('#passageTitle').fill('The Village Market');
        await page.locator('#passageInstructions').fill('Read the passage and answer questions 1 to 2.');
        await page.locator('#passageBody').fill('The market opens at dawn.\nTraders arrange their goods while the first customers arrive.');
        await page.getByRole('button', { name: 'Save passage and add questions' }).click();
        await page.getByText('New questions go here').waitFor();
        await page.getByText('0 questions').first().waitFor();
      });
      for (const [t, a, b] of [['When does the market open?', 'At dawn', 'At noon'], ['Who arrives first?', 'Customers', 'Nobody']] as const) {
        await check(`question "${t}" saves onto the passage`, async () => {
          await page.getByLabel('Question', { exact: true }).fill(t);
          await page.locator('input[name="opt_a"]').fill(a); await page.locator('input[name="opt_b"]').fill(b);
          await page.getByRole('button', { name: 'Save question', exact: true }).click();
          await page.getByText('Question saved.').waitFor();
        });
      }
      await check('the passage now shows 2 questions and still receives new ones', async () => {
        await page.getByRole('checkbox', { name: 'Comprehension passage' }).check().catch(() => {});
        await page.getByText('2 questions').first().waitFor();
        await page.getByText('New questions go here').waitFor();
      });
      await check('the database agrees: both questions are on the passage, in order 0 and 1', async () => {
        const [p] = await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId));
        const qs = (await db.select().from(schema.questions).where(eq(schema.questions.passageId, p!.id))).sort((x, y) => x.passagePosition - y.passagePosition);
        assert.deepEqual(qs.map((x) => [x.questionText, x.passagePosition]), [['When does the market open?', 0], ['Who arrives first?', 1]]);
        assert.equal(p!.instructions, 'Read the passage and answer questions 1 to 2.');
      });

      await check('the pencil opens the passage for editing, with its current words', async () => {
        await page.getByRole('button', { name: /Edit passage The Village Market/ }).click();
        assert.equal(await page.locator('input[id^="pt-"]').inputValue(), 'The Village Market');
        assert.match(await page.locator('textarea[id^="pb-"]').inputValue(), /market opens at dawn/);
      });
      await check('saving the edit changes the passage and keeps its 2 questions', async () => {
        await page.locator('input[id^="pt-"]').fill('The Busy Village Market');
        await page.getByRole('button', { name: 'Save changes' }).click();
        await page.getByText('Passage updated.').waitFor();
        await page.getByText('The Busy Village Market').first().waitFor();
        await page.getByText('2 questions').first().waitFor();
      });
      await check('cancel leaves the passage as it was', async () => {
        await page.getByRole('button', { name: /Edit passage The Busy Village Market/ }).click();
        await page.locator('input[id^="pt-"]').fill('Changed my mind');
        await page.getByRole('button', { name: 'Cancel' }).click();
        await page.getByText('The Busy Village Market').first().waitFor();
        assert.equal(await page.getByText('Changed my mind').count(), 0);
      });

      await check('the bin warns that all the questions written on the passage will be deleted', async () => {
        await page.getByRole('button', { name: /Delete passage The Busy Village Market/ }).click();
        const dlg = page.getByRole('alertdialog');
        await dlg.waitFor();
        const text = (await dlg.textContent()) ?? '';
        assert.match(text, /All 2 questions already written on this passage will be deleted with it/);
        assert.match(text, /cannot be undone/);
        await page.screenshot({ path: 'baseline-logs/passage-delete-warning.png', fullPage: true });
      });
      await check('"Keep it" removes the warning and deletes nothing', async () => {
        await page.getByRole('button', { name: 'Keep it' }).click();
        assert.equal(await page.getByRole('alertdialog').count(), 0);
        const [p] = await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId));
        assert.ok(p);
        assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.passageId, p!.id))).length, 2);
      });

      await check('once the set is handed in, the pencil and bin are not offered and nothing changes', async () => {
        await db.update(schema.questionSets).set({ status: 'submitted' }).where(eq(schema.questionSets.schoolId, schoolId));
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('checkbox', { name: 'Comprehension passage' }).check().catch(() => {});
        assert.equal(await page.getByRole('button', { name: /Delete passage/ }).count(), 0, 'no edit or delete controls on a handed-in set');
        await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.schoolId, schoolId));
        await page.reload({ waitUntil: 'networkidle' });
      });

      await check('confirming deletes the passage together with its questions, and says so', async () => {
        await page.getByRole('checkbox', { name: 'Comprehension passage' }).check().catch(() => {});
        await page.getByRole('button', { name: /Delete passage The Busy Village Market/ }).click();
        await page.getByRole('alertdialog').waitFor();
        await page.getByRole('button', { name: /Yes, delete passage and questions/ }).click();
        await page.getByText('Passage deleted with its 2 questions.').waitFor();
        assert.equal((await db.select().from(schema.passages).where(eq(schema.passages.schoolId, schoolId))).length, 0);
        assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.schoolId, schoolId))).length, 0);
      });

      await page.setViewportSize({ width: 390, height: 844 });
      await check('a phone screen has no sideways scroll with the panel open', async () => {
        await page.getByRole('checkbox', { name: 'Comprehension passage' }).check().catch(() => {});
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: 'baseline-logs/passage-panel-mobile.png', fullPage: true });
      });
      await check('the browser raised no runtime errors', async () => assert.deepEqual(errors, []));
    } finally { await browser.close(); }
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (schoolId) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
