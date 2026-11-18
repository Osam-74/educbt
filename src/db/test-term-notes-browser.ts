/**
 * Class teacher's Remarks and attendance screen, driven in a real browser against a real production build:
 * type a remark and days into a pupil's row, save, see the confirmation, reload and find them saved, get a clear
 * refusal for impossible days, and see a pupil whose results are under review locked.
 * Needs a built app (`npx next start -p 3100`) and Playwright. Disposable LOCAL database only; run by hand like
 * the other browser suites (it needs a running server, so it is not in the CI loop).
 *   NOTES_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs NOTES_BASE_URL=http://127.0.0.1:3100 \
 *   npx tsx src/db/test-term-notes-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  const base = new URL(process.env.NOTES_BASE_URL ?? 'http://127.0.0.1:3100');
  const { chromium } = await import(process.env.NOTES_BROWSER_MODULE ?? 'playwright');
  const { schema } = await import('@/db');
  const { createSession } = await import('@/lib/auth/session-store');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0, schoolId = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  try {
    const sub = 'tn' + randomUUID().slice(0, 6).toLowerCase();
    const [school] = await db.insert(schema.schools).values({ name: 'Term Notes E2E', code: 'TN-' + randomUUID().slice(0, 8), subdomain: sub }).returning();
    schoolId = school!.id;
    const [user] = await db.insert(schema.users).values({ schoolId, role: 'teacher', loginId: 'tn-teacher', passwordHash: 'unused', mustChangePassword: false }).returning();
    const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role: 'teacher', staffNumber: 'T1', firstName: 'Tola', lastName: 'Teacher' }).returning();
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: staff!.id, classId: room!.id, assignmentType: 'class_teacher' });
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    const pupil = async (n: string, last: string, state: 'compiled' | 'reviewed') => {
      const [s] = await db.insert(schema.students).values({ schoolId, admissionNumber: n, firstName: 'Pupil' + n, lastName: last }).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, sessionId: session!.id, classId: room!.id });
      await db.insert(schema.subjectResults).values({ schoolId, studentId: s!.id, subjectId: subject!.id, sessionId: session!.id, termId: term!.id, complete: true, total: '50', state, gradingScaleId: 'school-' + schoolId, gradingScaleVersion: 1 });
      return s!;
    };
    const open = await pupil('001', 'Adeyemi', 'compiled'), locked = await pupil('002', 'Zubairu', 'reviewed');

    const { token } = await createSession(Number(user!.id), '127.0.0.1', 'term-notes-e2e');
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ baseURL: base.origin });
    await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
    const page = await ctx.newPage();
    const row = (name: string) => page.locator('tr', { has: page.locator('th', { hasText: name }) });
    try {
      await page.goto('/portal/remarks');
      await check('the class teacher sees their class and both pupils', async () => {
        await page.getByRole('heading', { name: /Remarks and attendance/ }).waitFor({ timeout: 15000 });
        assert.equal(await page.locator('tbody tr', { has: page.locator('th[scope=row]') }).count(), 2);
      });
      await check('a pupil whose results are under review is locked, with no Save button', async () => {
        const r = row('Zubairu');
        assert.match(await r.innerText(), /under review/);
        assert.equal(await r.getByRole('button', { name: 'Save' }).count(), 0);
        assert.equal(await r.locator('textarea').isDisabled(), true);
      });
      await check('typing a remark and days and saving shows a confirmation', async () => {
        const r = row('Adeyemi');
        await r.locator('textarea').fill('A diligent and respectful pupil.');
        await r.locator('input[name=present]').fill('57'); await r.locator('input[name=total]').fill('60');
        await r.getByRole('button', { name: 'Save' }).click();
        await r.getByText('Changes saved.').waitFor({ timeout: 15000 });
      });
      await check('the values are in the database, together', async () => {
        const [s] = await db.select().from(schema.termSummaries).where(eq(schema.termSummaries.studentId, open.id));
        assert.equal(s!.daysPresent, 57); assert.equal(s!.daysTotal, 60);
        const [rem] = await db.select().from(schema.reportRemarks).where(eq(schema.reportRemarks.studentId, open.id));
        assert.equal(rem!.remark, 'A diligent and respectful pupil.'); assert.equal(rem!.source, 'manual');
      });
      await check('after a reload the saved remark and days are still in the row', async () => {
        await page.reload(); const r = row('Adeyemi');
        await r.locator('textarea').waitFor({ timeout: 15000 });
        assert.equal(await r.locator('textarea').inputValue(), 'A diligent and respectful pupil.');
        assert.equal(await r.locator('input[name=present]').inputValue(), '57'); assert.equal(await r.locator('input[name=total]').inputValue(), '60');
      });
      await check('more days present than days open is refused with a clear message and changes nothing', async () => {
        const r = row('Adeyemi');
        await r.locator('textarea').fill('This must not be saved.');
        await r.locator('input[name=present]').fill('70'); await r.locator('input[name=total]').fill('60');
        await r.getByRole('button', { name: 'Save' }).click();
        await r.getByRole('alert').filter({ hasText: 'cannot be more than' }).waitFor({ timeout: 15000 });
        const [s] = await db.select().from(schema.termSummaries).where(eq(schema.termSummaries.studentId, open.id));
        assert.equal(s!.daysPresent, 57);
        const [rem] = await db.select().from(schema.reportRemarks).where(eq(schema.reportRemarks.studentId, open.id));
        assert.equal(rem!.remark, 'A diligent and respectful pupil.');
      });
      await check('leaving the days empty is refused rather than saved as zero', async () => {
        const r = row('Adeyemi');
        await r.locator('input[name=present]').fill(''); await r.locator('input[name=total]').fill('');
        await r.getByRole('button', { name: 'Save' }).click();
        await r.getByRole('alert').waitFor({ timeout: 15000 });
        const [s] = await db.select().from(schema.termSummaries).where(eq(schema.termSummaries.studentId, open.id));
        assert.equal(s!.daysPresent, 57);
      });
      await check('the locked pupil\'s data was never touched', async () => assert.equal((await db.select().from(schema.termSummaries).where(eq(schema.termSummaries.studentId, locked.id))).length, 0));
    } finally { await browser.close(); }
    console.log(`${count} term notes browser checks passed`);
  } finally {
    if (schoolId) await owner`delete from schools where id = ${schoolId}`.catch(() => {});
    await owner.end();
  }
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
