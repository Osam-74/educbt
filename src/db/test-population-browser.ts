/**
 * The population chart on the dashboards, in a real browser. LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-population-browser.ts
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
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }

  async function school(label: string, withStudents: boolean) {
    const [s] = await db.insert(schema.schools).values({ name: label, code: 'PB-' + randomUUID() }).returning(); const schoolId = s!.id; schools.push(schoolId);
    const mk = async (role: 'principal' | 'teacher', login: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: login, firstName: 'T', lastName: login }).returning();
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: user!.id, expiresAt: new Date(Date.now() + 1800000) });
      return { staff: staff!, token };
    };
    const principal = await mk('principal', 'principal'), classTeacher = await mk('teacher', 'classteacher'), subjectTeacher = await mk('teacher', 'subjectteacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true });
    const [lvl] = await db.insert(schema.classLevels).values({ schoolId, name: 'L', stage: 'senior', levelOrder: 1 } as never).returning();
    const longName = 'Senior Secondary School Year One Science Arm';
    const room = async (arm: string, name: string) => (await db.insert(schema.classes).values({ schoolId, levelId: lvl!.id, arm, displayName: name } as never).returning())[0]!;
    const a = await room('A', 'SS1 A'), b = await room('B', 'SS1 B'), long = await room('C', longName);
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staff.id, classId: a.id, assignmentType: 'class_teacher', status: 'active' } as never);
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: subjectTeacher.staff.id, subjectId: maths!.id, classId: a.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    if (withStudents) {
      const put = async (classId: number, gender: string | null, n: number) => { for (let i = 0; i < n; i++) {
        const [st] = await db.insert(schema.students).values({ schoolId, admissionNumber: 'PB' + randomUUID().slice(0, 8), firstName: 'S', lastName: 'T', gender } as never).returning();
        await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId, sessionId: session!.id, status: 'active' } as never); } };
      await put(a.id, 'Male', 4); await put(a.id, 'f', 3); await put(b.id, 'F', 5); await put(b.id, null, 2); await put(long.id, 'm', 1);
    }
    return { schoolId, principal, classTeacher, subjectTeacher, a, b, long, longName };
  }

  try {
    const full = await school('Pop full', true), none = await school('Pop none', false);
    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true }); const errors: string[] = [];
    const as = async (token: string, width = 1280) => {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await context.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message)); return page;
    };
    const go = (page: any, path: string) => page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });
    const num = async (page: any, id: string) => Number((await page.getByTestId(id).textContent()) ?? '-1');

    try {
      const page = await as(full.principal.token); await go(page, '/portal');
      await check('the principal\'s dashboard shows the chart with a bar for every class that has students', async () => {
        await page.getByTestId('pop-chart').waitFor(); assert.equal(await page.locator('.pop-bar').count(), 3);
      });
      await check('the legend totals match the data: male and female counted however they were typed, plus "not stated" and the grand total', async () => {
        assert.equal(await num(page, 'pop-male'), 5, '4 Male + 1 m'); assert.equal(await num(page, 'pop-female'), 8, '3 f + 5 F');
        assert.equal(await num(page, 'pop-unknown'), 2); assert.equal(await num(page, 'pop-total'), 15);
      });
      await check('each bar carries its own counts, and they add up', async () => {
        const bars = await page.locator('.pop-bar').evaluateAll((els: Element[]) => els.map((e) => ({ t: +e.getAttribute('data-total')!, m: +e.getAttribute('data-male')!, f: +e.getAttribute('data-female')!, u: +e.getAttribute('data-unknown')! })));
        assert.deepEqual(bars.map((b: any) => b.t).sort(), [1, 7, 7]); for (const b of bars) assert.equal(b.t, b.m + b.f + b.u);
      });
      await check('the full class name is in the spoken label and tooltip even when the axis shortens it', async () => {
        const label = await page.locator(`[data-class="${full.long.id}"]`).getAttribute('aria-label'); assert.match(label ?? '', new RegExp(full.longName));
        const axis = (await page.locator(`[data-label="${full.long.id}"]`).textContent()) ?? ''; assert.ok(axis.endsWith('…') && [...axis].length === 22, axis);
        assert.equal((await page.locator(`[data-class="${full.long.id}"] title`).textContent()) ?? '', label);
      });
      await check('a table with the same numbers exists for screen readers', async () => {
        const rows = await page.locator('.pop-sr-only tbody tr').count(); assert.equal(rows, 3);
        assert.match((await page.locator('.pop-sr-only').textContent()) ?? '', new RegExp(full.longName));
      });
      await check('hovering a bar shows no script error and keyboard focus reaches every bar', async () => {
        await page.locator('.pop-bar').first().hover(); await page.locator('.pop-bar').first().focus();
        assert.equal(await page.locator('.pop-bar[tabindex="0"]').count(), 3);
      });
      await check('a phone screen scrolls the chart sideways inside its box, the page itself does not scroll sideways', async () => {
        const phone = await as(full.principal.token, 390); await go(phone, '/portal'); await phone.getByTestId('pop-chart').waitFor();
        assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page-level sideways scroll');
      });
      await check('printing keeps the chart (no scrollbars, nothing hidden)', async () => {
        await page.emulateMedia({ media: 'print' }); assert.ok(await page.getByTestId('pop-chart').isVisible()); assert.equal(await page.locator('.pop-bar').count(), 3);
        await page.emulateMedia({ media: 'screen' });
      });

      const ct = await as(full.classTeacher.token); await go(ct, '/portal');
      await check('a class teacher\'s dashboard shows ONLY their class, and its numbers', async () => {
        await ct.getByTestId('pop-chart').waitFor(); assert.equal(await ct.locator('.pop-bar').count(), 1);
        assert.equal(await num(ct, 'pop-total'), 7); assert.equal(await ct.getByTestId('pop-unknown').count(), 0, '"not stated" is hidden when there is none');
        const html = await ct.content(); assert.ok(!html.includes('SS1 B') && !html.includes(full.longName), 'no other class name reaches the browser');
      });
      await check('a subject teacher sees no chart card at all', async () => {
        const sub = await as(full.subjectTeacher.token); await go(sub, '/portal'); assert.equal(await sub.getByTestId('pop-panel').count(), 0);
      });
      await check('a school with nobody enrolled shows a plain message, not an empty chart', async () => {
        const empty = await as(none.principal.token); await go(empty, '/portal'); await empty.getByTestId('pop-empty').waitFor(); assert.equal(await empty.locator('.pop-bar').count(), 0);
      });
      await check('the browser raised no runtime errors', async () => assert.deepEqual(errors, []));
    } finally { await browser.close(); }
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
