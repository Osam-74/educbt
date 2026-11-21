/**
 * Assign arms in a real browser: open the panel, choose the class and the arm, tick students, apply, read the outcome.
 * LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-arm-browser.ts
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
  const settle = async (ok: () => Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 150)); } };

  try {
    const [school] = await db.insert(schema.schools).values({ name: 'Arms UI', code: 'AU-' + randomUUID() }).returning(); schoolId = school!.id;
    const mk = async (role: 'principal' | 'teacher', login: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: login, firstName: 'T', lastName: login }).returning();
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: user!.id, expiresAt: new Date(Date.now() + 1800000) });
      return { user: user!, staff: staff!, token };
    };
    const principal = await mk('principal', 'principal'), classTeacher = await mk('teacher', 'classteacher'), subjectTeacher = await mk('teacher', 'subjectteacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [ss1] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS1', stage: 'senior' }).returning();
    const room = async (arm: string | null, name: string, extra: Record<string, unknown> = {}) => (await db.insert(schema.classes).values({ schoolId, levelId: ss1!.id, arm, displayName: name, ...extra } as never).returning())[0]!;
    const plain = await room(null, 'SS1'), armA = await room('A', 'SS1 A'), armB = await room('B', 'SS1 B', { capacity: 2 });
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staff.id, classId: plain.id, assignmentType: 'class_teacher', status: 'active' } as never);
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: classTeacher.staff.id, classId: armA.id, assignmentType: 'class_teacher', status: 'active' } as never);
    const [maths] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    const students: Array<{ id: number; last: string }> = [];
    for (let i = 0; i < 5; i++) {
      const [s] = await db.insert(schema.students).values({ schoolId, admissionNumber: 'AU' + i + randomUUID().slice(0, 4), firstName: 'Stu', lastName: 'Name' + i } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId: plain.id, sessionId: session!.id, status: 'active' } as never);
      students.push({ id: Number(s!.id), last: 'Name' + i });
    }
    // Student 4 already has a score this term, so the split must refuse them and say why.
    await db.insert(schema.assessmentScores).values({ schoolId, studentId: students[4]!.id, subjectId: maths!.id, sessionId: session!.id, termId: term!.id, componentKey: 'ca1', score: '10', maxScore: '20' } as never);
    const classOf = async (id: number) => Number((await db.select().from(schema.enrollments).where(eq(schema.enrollments.studentId, id)))[0]!.classId);

    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true });
    const errors: string[] = [];
    const as = async (token: string, width = 1280) => {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await context.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message)); return page;
    };
    const go = (page: any, path: string) => page.goto(new URL(path, base).href, { waitUntil: 'networkidle' });

    try {
      const page = await as(principal.token);
      await go(page, '/portal/students');
      await check('the principal sees the Assign arms card, closed by default', async () => {
        await page.getByTestId('arm-panel-wrap').waitFor(); assert.equal(await page.getByTestId('arm-panel').count(), 0);
      });
      await check('opening it offers the class with students, the arms to move into, and its students', async () => {
        await page.getByTestId('arm-open').click(); await page.getByTestId('arm-panel').waitFor();
        assert.match((await page.locator('#arm-from').textContent()) ?? '', /SS1 \(5\)/);
        const arms = await page.locator('#arm-to option').allTextContents(); assert.deepEqual(arms.map((a: string) => a.trim()), ['Choose an arm…', 'SS1 A', 'SS1 B']);
        assert.equal(await page.locator('[data-student]').count(), 5);
      });
      await check('Apply stays off until a student is ticked AND an arm is chosen', async () => {
        const apply = page.getByTestId('arm-apply'); assert.equal(await apply.isDisabled(), true);
        await page.locator('[data-student] input').first().check(); assert.equal(await apply.isDisabled(), true, 'a student alone is not enough');
        await page.locator('#arm-to').selectOption({ label: 'SS1 A' }); assert.equal(await apply.isDisabled(), false);
        await page.locator('[data-student] input').first().uncheck(); assert.equal(await apply.isDisabled(), true, 'an arm alone is not enough');
      });
      await check('"Tick all" and "Clear ticks" work and the count follows', async () => {
        await page.getByTestId('arm-all').click(); assert.match((await page.getByTestId('arm-count').textContent()) ?? '', /5 selected/);
        await page.getByTestId('arm-none').click(); assert.match((await page.getByTestId('arm-count').textContent()) ?? '', /0 selected/);
      });
      await check('applying moves the ticked students into the arm and reports how many', async () => {
        await page.locator('[data-student] input').nth(0).check(); await page.locator('[data-student] input').nth(1).check();
        await page.locator('#arm-to').selectOption({ label: 'SS1 A' }); await page.getByTestId('arm-apply').click();
        await page.getByTestId('arm-outcome').waitFor();
        assert.match((await page.getByTestId('arm-outcome').textContent()) ?? '', /2 students moved/);
        await settle(async () => (await classOf(students[0]!.id)) === Number(armA.id));
        assert.equal(await classOf(students[0]!.id), Number(armA.id)); assert.equal(await classOf(students[1]!.id), Number(armA.id));
        assert.equal(await classOf(students[2]!.id), Number(plain.id), 'unticked students stay');
      });
      await check('a student the rules refuse is named with the reason, and the rest still move', async () => {
        await go(page, '/portal/students'); await page.getByTestId('arm-open').click(); await page.getByTestId('arm-panel').waitFor();
        await page.getByTestId('arm-all').click(); await page.locator('#arm-to').selectOption({ label: 'SS1 A' }); await page.getByTestId('arm-apply').click();
        await page.getByTestId('arm-skipped').waitFor();
        const text = (await page.getByTestId('arm-outcome').textContent()) ?? '';
        assert.match(text, /2 students moved/); assert.match(text, /1 not moved/); assert.match(text, /Name4/); assert.match(text, /Already has 1 score recorded this term/);
        assert.equal(await classOf(students[4]!.id), Number(plain.id), 'the refused student did not move');
        assert.equal(await classOf(students[3]!.id), Number(armA.id));
      });
      await check('a phone screen has no sideways scroll with the panel open', async () => {
        const phone = await as(principal.token, 390); await go(phone, '/portal/students'); await phone.getByTestId('arm-open').click(); await phone.getByTestId('arm-panel').waitFor();
        assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      });

      // ── a class teacher, on their own roster ─────────────────────────────
      await db.update(schema.enrollments).set({ classId: plain.id }).where(eq(schema.enrollments.studentId, students[0]!.id));
      const teacher = await as(classTeacher.token);
      await check('a class teacher gets the panel on My Students, offering only their own class', async () => {
        await go(teacher, '/portal/students?scope=mine'); await teacher.getByTestId('arm-open').click(); await teacher.getByTestId('arm-panel').waitFor();
        assert.match((await teacher.locator('#arm-from').textContent()) ?? '', /SS1/);
        const arms = (await teacher.locator('#arm-to option').allTextContents()).map((a: string) => a.trim()); assert.deepEqual(arms, ['Choose an arm…', 'SS1 A'], 'SS1 B is not theirs');
      });
      await check('a class teacher can split into their own arm', async () => {
        await teacher.locator('[data-student] input').first().check(); await teacher.locator('#arm-to').selectOption({ label: 'SS1 A' }); await teacher.getByTestId('arm-apply').click();
        await teacher.getByTestId('arm-outcome').waitFor(); assert.match((await teacher.getByTestId('arm-outcome').textContent()) ?? '', /1 student moved/);
      });
      await check('a subject teacher sees no Assign arms card at all', async () => {
        const sub = await as(subjectTeacher.token); await go(sub, '/portal/students?scope=mine'); assert.equal(await sub.getByTestId('arm-panel-wrap').count(), 0);
      });
      await check('a teacher cannot even select an arm they do not hold: a forged value leaves Apply disabled and nothing moves', async () => {
        const forged = await as(classTeacher.token); await go(forged, '/portal/students?scope=mine'); await forged.getByTestId('arm-open').click(); await forged.getByTestId('arm-panel').waitFor();
        await forged.locator('[data-student] input').first().check();
        // Slip in an option for SS1 B that the page never offered. The panel only accepts arms it was given.
        await forged.evaluate((id: number) => { const sel = document.querySelector('#arm-to') as HTMLSelectElement; const o = document.createElement('option'); o.value = String(id); o.text = 'forged'; sel.appendChild(o); sel.value = String(id); sel.dispatchEvent(new Event('change', { bubbles: true })); }, Number(armB.id));
        assert.equal(await forged.getByTestId('arm-apply').isDisabled(), true, 'Apply stays off for an arm that was not offered');
        assert.equal((await db.select().from(schema.enrollments).where(eq(schema.enrollments.classId, armB.id))).length, 0);
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
