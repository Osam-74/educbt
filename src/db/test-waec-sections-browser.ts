/**
 * WAEC sections in a real browser: choose a section when writing a question, watch the progress table, move a
 * question, and see the section lock once the question is approved. LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-waec-sections-browser.ts
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
  const { saveCollection } = await import('@/lib/exam/collection');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  let schoolId = 0, checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  try {
    const [school] = await db.insert(schema.schools).values({ name: 'WAEC sections UI', code: 'WB-' + randomUUID() }).returning(); schoolId = school!.id;
    const mk = async (role: 'principal' | 'teacher', loginId: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: loginId, firstName: 'T', lastName: loginId }).returning();
      return { user: user!, staff: staff! };
    };
    const principal = await mk('principal', 'principal'), teacher = await mk('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'Year 11', stage: 'senior' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'Year 11 A' }).returning();
    const [english] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staff.id, subjectId: english!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    await saveCollection({ schoolId, userId: principal.user.id, role: 'principal', staffId: principal.staff.id, studentId: null, loginId: 'principal' }, { objective: 1, theory: 1, seriesId: series!.id });
    const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: teacher.user.id, expiresAt: new Date(Date.now() + 1800000) });

    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1100 } });
      await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await context.newPage(); const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(e.message));
      const questions = () => db.select().from(schema.questions).where(eq(schema.questions.schoolId, schoolId));
      const settle = async (ok: () => Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 150)); } };
      const clean = () => page.url().replace(/&?(error|ok)=[^&]*/g, '');
      const addQ = async (text: string, section?: string) => {
        await page.getByLabel('Question', { exact: true }).fill(text);
        await page.locator('input[name="opt_a"]').fill('Yes'); await page.locator('input[name="opt_b"]').fill('No');
        if (section) await page.locator('select[name="section"]').first().selectOption(section);
        await page.getByRole('button', { name: 'Save question', exact: true }).click();
        await page.getByText('Question saved.').waitFor();
      };

      await page.goto(new URL('/portal/questions', base).href, { waitUntil: 'networkidle' });
      await page.locator('#qs-subject').selectOption(String(english!.id));
      await page.locator('#qs-class').selectOption(`${level!.id}:`);
      await page.waitForURL(/setId=/); await page.waitForLoadState('networkidle');

      await check('an ordinary set shows no WAEC sections', async () => {
        assert.equal(await page.getByRole('region', { name: 'WAEC sections' }).count(), 0);
        assert.equal(await page.locator('select[name="section"]').count(), 0);
      });
      await check('ticking WAEC Standard shows the section table: all 11 objective sections, none complete', async () => {
        await page.getByRole('checkbox', { name: /WAEC Standard/ }).check();
        await page.waitForURL(/waecMode=1/); await page.waitForLoadState('networkidle');
        await page.getByRole('region', { name: 'WAEC sections' }).waitFor();
        assert.equal(await page.locator('.qs-waec__table tbody tr').count(), 11);
        assert.equal(await page.locator('.qs-waec__table tbody tr[data-done="yes"]').count(), 0);
      });
      await check('the add form offers the sections grouped by paper', async () => {
        const groups = await page.locator('select[name="section"]').first().locator('optgroup').evaluateAll((els: HTMLOptGroupElement[]) => els.map((e) => e.label));
        assert.deepEqual(groups, ['Paper 1 — Objective Test', 'Paper 3 — Test of Orals']);
      });
      await check('a question saved with a section lands in that section and the table counts it', async () => {
        await addQ('Pick the antonym of "brave".', 'paper1:antonyms');
        assert.deepEqual((await questions()).map((q) => q.section), ['paper1:antonyms']);
        assert.equal((await page.locator('tr[data-section="paper1:antonyms"] td').nth(1).textContent())?.trim(), '1');
      });
      await check('a question saved with no section is reported as not placed yet', async () => {
        await addQ('Unplaced question about grammar.');
        assert.match((await page.getByTestId('waec-unplaced').textContent()) ?? '', /1 question is not in a section yet/);
      });
      await check('the unplaced question can be given a section from the list', async () => {
        const q = (await questions()).find((x) => x.section === '')!;
        await page.locator(`#sec-${q.id}`).selectOption('paper1:grammar');
        await page.locator(`[data-testid="section-form-${q.id}"] button`).click();
        await page.getByText('Question updated.').waitFor();
        assert.equal((await questions()).find((x) => x.id === q.id)!.section, 'paper1:grammar');
        assert.equal(await page.getByTestId('waec-unplaced').count(), 0, 'the unplaced note is gone');
      });
      await check('a question can be moved again while it is not approved', async () => {
        const q = (await questions()).find((x) => x.section === 'paper1:grammar')!;
        await page.locator(`#sec-${q.id}`).selectOption('paper1:idioms');
        await page.locator(`[data-testid="section-form-${q.id}"] button`).click();
        // The previous move's "Question updated." may still be on screen, so the saved value itself is the signal.
        await settle(async () => (await questions()).find((x) => x.id === q.id)!.section === 'paper1:idioms');
        assert.equal((await questions()).find((x) => x.id === q.id)!.section, 'paper1:idioms');
      });
      await check('once approved, the question shows its section as locked and offers no way to change it', async () => {
        const q = (await questions()).find((x) => x.section === 'paper1:idioms')!;
        await db.update(schema.questions).set({ approvalStatus: 'approved' }).where(eq(schema.questions.id, q.id));
        await page.goto(clean(), { waitUntil: 'networkidle' });
        const locked = page.getByTestId(`section-locked-${q.id}`); await locked.waitFor();
        assert.match((await locked.textContent()) ?? '', /Idioms and Interpretations · locked/);
        assert.equal(await page.getByTestId(`section-form-${q.id}`).count(), 0, 'no form to change it');
        assert.match((await locked.getAttribute('title')) ?? '', /approved, so its section can no longer be changed/);
      });
      await check('a forged edit of the locked question is refused by the server and changes nothing', async () => {
        const locked = (await questions()).find((x) => x.section === 'paper1:idioms')!;
        const open = (await questions()).find((x) => x.section === 'paper1:antonyms')!;
        // Re-point the still-open question's form at the locked question, as a forged post would.
        await page.evaluate(({ from, to }: { from: number; to: number }) => {
          const form = document.querySelector(`[data-testid="section-form-${from}"]`)!;
          (form.querySelector('input[name="questionId"]') as HTMLInputElement).value = String(to);
          (form.querySelector('select') as HTMLSelectElement).value = 'paper1:cloze';
        }, { from: open.id, to: locked.id });
        await page.locator(`[data-testid="section-form-${open.id}"] button`).click();
        await page.getByText(/approved, so its section can no longer be changed/).first().waitFor();
        assert.equal((await questions()).find((x) => x.id === locked.id)!.section, 'paper1:idioms', 'unchanged');
      });
      await check('once the set is handed in nothing can be moved', async () => {
        await db.update(schema.questionSets).set({ status: 'submitted' }).where(eq(schema.questionSets.schoolId, schoolId));
        await page.goto(clean(), { waitUntil: 'networkidle' });
        assert.equal(await page.locator('[data-testid^="section-form-"]').count(), 0);
        await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.schoolId, schoolId));
      });
      await check('a phone screen has no sideways scroll with the section table and controls', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(clean(), { waitUntil: 'networkidle' });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
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
