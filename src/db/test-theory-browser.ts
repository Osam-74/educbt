/**
 * Theory delivery in a real browser: the student sits objective questions then theory, types an answer, submits; the
 * teacher then finds every theory script (typed or blank) in the marking queue and marks one. LOCAL disposable database
 * and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-theory-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const base = new URL(process.env.CA_TEST_HTTP_URL ?? ''); assert(['127.0.0.1', 'localhost'].includes(base.hostname));
  assert(process.env.QUESTION_BROWSER_MODULE, 'browser runtime required');
  const { schema, client } = await import('@/db');
  const { createSeries, composeSeries } = await import('@/lib/exam/compose');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const schools: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  const sessionFor = async (userId: number) => { const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId, expiresAt: new Date(Date.now() + 3600000) }); return token; };

  try {
    const [school] = await db.insert(schema.schools).values({ name: 'Theory browser', code: 'TB-' + randomUUID() }).returning(); const schoolId = school!.id; schools.push(schoolId);
    const mkStaff = async (role: 'exam_officer' | 'teacher', login: string) => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [s] = await db.insert(schema.staff).values({ schoolId, userId: u!.id, role, staffNumber: login, firstName: login, lastName: 'X' }).returning();
      return { user: u!, staff: s!, actor: { schoolId, userId: u!.id, role, staffId: s!.id, studentId: null, loginId: login } as Actor };
    };
    const officer = await mkStaff('exam_officer', 'officer'), teacher = await mkStaff('teacher', 'teacher');
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', stage: 'junior', levelOrder: 1 } as never).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, arm: 'A', displayName: 'JSS1 A' } as never).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: teacher.staff.id, subjectId: subject!.id, classId: room!.id, assignmentType: 'subject_teacher', status: 'active' } as never);
    const series = await createSeries(officer.actor, { title: 'Term exam', seriesType: 'examination', sessionId: session!.id, termId: term!.id, questionsPerStudent: 2, durationMinutes: 60 } as never);
    const base0 = { schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, seriesId: 0, teacherId: teacher.staff.id };
    const [oset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'objective', status: 'approved' }).returning();
    for (let i = 1; i <= 4; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: oset!.id, questionText: `Objective question ${i}?`, sequence: i, approvalStatus: 'approved', status: 'active', marks: '2' } as never).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Right', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'Wrong', isCorrect: false, sortOrder: 1 }]);
    }
    const [tset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'theory', status: 'approved' }).returning();
    for (let i = 1; i <= 2; i++) await db.insert(schema.questions).values({ schoolId, questionSetId: tset!.id, questionText: `Explain theory topic ${i}.`, questionType: 'theory', sequence: 100 + i, approvalStatus: 'approved', status: 'active', marks: '10', markingGuide: `Guide for ${i}` } as never);
    await composeSeries(officer.actor, Number(series.id));
    const [paper] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(series.id)));
    await db.update(schema.examSeries).set({ status: 'published', sittingOpensAt: new Date(Date.now() - 3600_000), sittingClosesAt: new Date(Date.now() + 3600_000) }).where(eq(schema.examSeries.id, Number(series.id)));
    await db.update(schema.examPapers).set({ status: 'published' }).where(eq(schema.examPapers.id, paper!.id));
    const mkStudent = async (label: string) => {
      const [u] = await db.insert(schema.users).values({ schoolId, role: 'student', loginId: label, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [st] = await db.insert(schema.students).values({ schoolId, userId: u!.id, admissionNumber: label + randomUUID().slice(0, 5), firstName: label, lastName: 'Pupil', gender: 'Male' } as never).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: st!.id, classId: room!.id, sessionId: session!.id, status: 'active' } as never);
      await db.insert(schema.studentSubjects).values({ schoolId, studentId: st!.id, subjectId: subject!.id, sessionId: session!.id } as never);
      return { token: await sessionFor(u!.id) };
    };
    const typer = await mkStudent('typer'), blank = await mkStudent('blank'), phone = await mkStudent('phone');
    const teacherToken = await sessionFor(teacher.user.id);

    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true }); const errors: string[] = [];
    const open = async (token: string, width = 1100) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message)); page.on('dialog', (d: any) => d.accept()); return page;
    };
    const roomOf = (page: any) => page.goto(new URL(`/exam/${paper!.id}`, base).href, { waitUntil: 'networkidle' });
    const submit = async (page: any) => { await page.locator('.exam__submit').click(); await page.waitForURL((u: URL) => !u.pathname.startsWith('/exam/'), { timeout: 20000 }).catch(() => undefined); await page.waitForTimeout(800); };

    try {
      const page = await open(typer.token); await roomOf(page);
      await check('the student sees objective questions first, then the theory questions, with a palette of all four', async () => {
        assert.equal(await page.locator('.pal').count(), 4, '2 objective + 2 theory');
        assert.equal(await page.locator('.exam__theory').count(), 0, 'question 1 is objective: no answer box yet');
        await page.locator('.pal').nth(2).click(); assert.equal(await page.locator('.exam__theory').count(), 1, 'question 3 is the first theory question');
        assert.match((await page.locator('.exam__text').textContent()) ?? '', /Explain theory topic/);
      });
      await check('the student types a theory answer and it counts as answered', async () => {
        await page.locator('.exam__theory').fill('Photosynthesis makes food from light.'); await page.waitForTimeout(1500);
        assert.match((await page.locator('.exam__palette .muted').first().textContent()) ?? '', /1 of 4 answered/);
        assert.ok((await page.locator('.pal').nth(2).getAttribute('class'))!.includes('pal--done'));
      });
      await check('submitting finishes the sitting', async () => { await submit(page); });
      const page2 = await open(blank.token); await roomOf(page2); await submit(page2);
      const page3 = await open(phone.token, 390); await roomOf(page3);
      await check('on a phone the theory box is usable and not wider than the screen', async () => {
        await page3.locator('.pal').nth(3).click(); const box = await page3.locator('.exam__theory').boundingBox();
        assert.ok(box && box.width <= 390 && box.width > 200, JSON.stringify(box));
        assert.ok(await page3.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
        await page3.locator('.exam__theory').fill('Phone answer.'); await page3.waitForTimeout(1500); await submit(page3);
      });

      const t = await open(teacherToken); await t.goto(new URL('/portal/marking', base).href, { waitUntil: 'networkidle' });
      await check('the teacher\'s marking page lists a script for every theory question of every student (3 x 2)', async () => {
        assert.equal(await t.locator('.eo-review-card').count(), 6); assert.match((await t.locator('.eo-status-bar').textContent()) ?? '', /6 answers waiting/);
      });
      await check('a typed answer is shown, and an untouched one says "No answer given."', async () => {
        const text = (await t.locator('.school-dashboard').first().textContent()) ?? '';
        assert.match(text, /Photosynthesis makes food from light\./); assert.match(text, /Phone answer\./); assert.ok((text.match(/No answer given\./g) ?? []).length >= 3);
      });
      await check('the question\'s marking guide is shown to the teacher', async () => assert.match((await t.locator('.eo-review-card').first().textContent()) ?? '', /Guide for \d/));
      await check('marking one script removes exactly that one from the queue', async () => {
        const card = t.locator('.eo-review-card', { hasText: 'Photosynthesis' }).first(); await card.locator('input[name="marks"]').fill('8'); await card.locator('button[type="submit"]').click();
        await t.waitForURL(/ok=1/); assert.equal(await t.locator('.eo-review-card').count(), 5); const left = await t.locator('.eo-review-card').allTextContents(); assert.ok(!left.some((c: string) => c.includes('Photosynthesis')), 'still listed: ' + left.filter((c: string) => c.includes('Photosynthesis')).map((c: string) => c.slice(0, 160)).join(' || '));
      });
      await check('a mark above the maximum is refused and the script stays in the queue', async () => {
        const card = t.locator('.eo-review-card').first(); assert.equal(await card.locator('input[name="marks"]').getAttribute('max'), '10');
        await card.locator('input[name="marks"]').evaluate((el: HTMLInputElement) => { el.removeAttribute('max'); }); await card.locator('input[name="marks"]').fill('11'); await card.locator('button[type="submit"]').click();
        await t.waitForURL(/error=/); await t.waitForLoadState('networkidle'); await t.locator('.eo-review-card').first().waitFor({ timeout: 10000 }); assert.match((await t.locator('p.error').textContent()) ?? '', /between 0 and 10/); assert.equal(await t.locator('.eo-review-card').count(), 5);
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
