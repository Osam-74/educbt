/**
 * Theory question parts, driven in a real browser against a real production build: add parts on the Question
 * Bank form, see the running total, get a clear refusal for a split that does not add up, then save a good one
 * and see the parts listed. Needs a built app (`npx next start -p 3100`) and Playwright. Disposable LOCAL
 * database only; not part of the CI loop (it needs a running server).
 *   THEORY_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs THEORY_BASE_URL=http://127.0.0.1:3100 \
 *   npx tsx src/db/test-theory-parts-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  const base = new URL(process.env.THEORY_BASE_URL ?? 'http://127.0.0.1:3100');
  const { chromium } = await import(process.env.THEORY_BROWSER_MODULE ?? 'playwright');
  const { schema } = await import('@/db');
  const { createSession } = await import('@/lib/auth/session-store');
  const { findOrCreateSet } = await import('@/lib/exam/sets');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0, schoolId = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  try {
    const sub = 'tp' + randomUUID().slice(0, 6).toLowerCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Theory Parts E2E', code: 'TP-' + randomUUID().slice(0, 8), subdomain: sub }).returning();
    schoolId = school!.id;
    const [user] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 'tp-teacher', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Tola', lastName: 'Teacher' }).returning();
    const actor = { schoolId, userId: user!.id, role: 'teacher' as const, staffId: staff!.id, studentId: null, loginId: 'tp-teacher' };
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'BIO', name: 'Biology' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: staff!.id, subjectId: subject!.id, classId: room!.id });
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term exams', seriesType: 'examination',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) } as never).returning();
    const [pu] = await db.insert(schema.users).values({ schoolId, role: 'principal', loginId: 'tp-principal', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [ps] = await db.insert(schema.staff).values({ schoolId, userId: pu!.id, role: 'principal', staffNumber: 'P1', firstName: 'Pat', lastName: 'Head' }).returning();
    const principal = { schoolId, userId: pu!.id, role: 'principal' as const, staffId: ps!.id, studentId: null, loginId: 'tp-principal' };
    const { saveCollection } = await import('@/lib/exam/collection');
    await saveCollection(principal as never, { objective: 1, theory: 1, seriesId: series!.id });
    const set = await findOrCreateSet(actor as never, { sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, departmentId: null, seriesId: 0, examType: 'theory', waecMode: false } as never);

    const { token } = await createSession(Number(user!.id), '127.0.0.1', 'theory-e2e');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ baseURL: base.origin });
    // Cookies are injected NON-secure: a server-set secure cookie is not attached to action POSTs over plain http.
    await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
    const page = await ctx.newPage();
    const open = () => page.goto(`/portal/questions?subjectId=${subject!.id}&levelId=${level!.id}&examType=theory&delivery=cbt&method=manual&setId=${set.id}`);
    await open();
    await check('the Parts block appears on a theory set', async () => { await page.getByText('Parts (optional)').waitFor({ timeout: 15000 }); });
    await page.fill('#text', 'Answer both parts on osmosis in plants.');
    await page.fill('#marks', '5');
    await page.getByRole('button', { name: 'Add a part' }).click();
    await page.getByRole('button', { name: 'Add a part' }).click();
    await check('two part rows exist, auto-labelled a and b', async () => {
      assert.equal(await page.inputValue('input[aria-label="Label for part 1"]'), 'a');
      assert.equal(await page.inputValue('input[aria-label="Label for part 2"]'), 'b');
    });
    await page.fill('input[aria-label="Text of part 1"]', 'Define osmosis.'); await page.fill('input[aria-label="Marks for part 1"]', '2');
    await page.fill('input[aria-label="Text of part 2"]', 'Give one example in plants.'); await page.fill('input[aria-label="Marks for part 2"]', '2');
    await check('the running total warns while the parts do not match', async () => { const t = await page.getByRole('status').filter({ hasText: 'Parts add up' }).innerText(); assert.match(t, /add up to 4 of 5/); assert.match(t, /must match/); });
    await page.getByRole('button', { name: 'Save question' }).click();
    await check('the server refuses the mismatch with the real numbers and saves nothing', async () => {
      // The route announcer is also role=alert and empty, so wait for the error paragraph by its text.
      const message = page.locator('p.error', { hasText: 'question is worth 5' });
      await message.waitFor({ timeout: 15000 });
      assert.match(await message.innerText(), /The parts add up to 4 but the question is worth 5/);
      assert.equal(Number((await owner`select count(*)::int as n from questions where question_set_id = ${set.id}`)[0]!.n), 0);
    });
    await open();
    await page.fill('#text', 'Answer both parts on osmosis in plants.'); await page.fill('#marks', '5');
    await page.getByRole('button', { name: 'Add a part' }).click(); await page.getByRole('button', { name: 'Add a part' }).click();
    await page.fill('input[aria-label="Text of part 1"]', 'Define osmosis.'); await page.fill('input[aria-label="Marks for part 1"]', '2');
    await page.fill('input[aria-label="Text of part 2"]', 'Give one example in plants.'); await page.fill('input[aria-label="Marks for part 2"]', '3');
    await check('the running total turns good when the parts match', async () => { assert.match(await page.getByRole('status').filter({ hasText: 'Parts add up' }).innerText(), /5 of 5\. Good\./); });
    await page.getByRole('button', { name: 'Save question' }).click();
    await check('a matching split saves and the parts are listed under the question', async () => {
      await page.locator('p.ok', { hasText: 'Question saved.' }).waitFor({ timeout: 15000 });
      const list = await page.locator('.qlist').innerText();
      assert.match(list, /\(a\) Define osmosis\./); assert.match(list, /2 marks/); assert.match(list, /\(b\) Give one example in plants\./); assert.match(list, /3 marks/);
      const rows = await owner`select label, marks::text from question_parts where school_id = ${schoolId} order by sequence`;
      assert.deepEqual(rows.map(r => [r.label, r.marks]), [['a', '2.00'], ['b', '3.00']]);
    });
    await page.fill('#text', 'A plain theory question with no parts at all.'); await page.fill('#marks', '2.5');
    await page.getByRole('button', { name: 'Save question' }).click();
    await check('a theory question with no parts and a decimal mark still saves as before', async () => {
      // The previous save's banner is still on screen, so wait for the NEW question to show in the list.
      await page.locator('.qlist', { hasText: 'A plain theory question with no parts' }).waitFor({ timeout: 15000 });
      const r = await owner`select q.marks::text as marks, (select count(*)::int from question_parts p where p.question_id = q.id) as parts from questions q where q.question_text like 'A plain theory%'`;
      assert.deepEqual([r[0]!.marks, r[0]!.parts], ['2.50', 0]);
    });
    await browser.close();
  } finally {
    if (schoolId) await owner`delete from schools where id = ${schoolId}`.catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end();
  }
  console.log(`${count} theory parts browser checks passed`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
