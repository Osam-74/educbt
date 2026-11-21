/**
 * Theory ON PAPER in a real browser: the student sits objective questions then theory, types an answer, submits; the
 * teacher then finds every theory script (typed or blank) in the marking queue and marks one. LOCAL disposable database
 * and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-theory-on-paper-browser.ts
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
  const { saveCollection } = await import('@/lib/exam/collection');
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
    await db.update(schema.examSeries).set({ questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).where(eq(schema.examSeries.id, Number(series.id)));
    await saveCollection(officer.actor, { objective: 1, theory: 1, seriesId: Number(series.id) });
    const base0 = { schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id, seriesId: 0, teacherId: teacher.staff.id };
    const [oset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'objective', status: 'approved' }).returning();
    for (let i = 1; i <= 4; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: oset!.id, questionText: `Objective question ${i}?`, sequence: i, approvalStatus: 'approved', status: 'active', marks: '2' } as never).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Right', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'Wrong', isCorrect: false, sortOrder: 1 }]);
    }
    const [tset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'theory', status: 'approved', theoryOnPaper: true }).returning();
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
      await check('the student still sees all four questions (2 objective then 2 theory) in the palette', async () => {
        assert.equal(await page.locator('.pal').count(), 4);
      });
      await check('a theory question shows the text to read, an "answer on paper" notice, and NO answer box', async () => {
        await page.locator('.pal').nth(2).click();
        assert.match((await page.locator('.exam__text').textContent()) ?? '', /Explain theory topic/);
        assert.equal(await page.locator('.exam__theory').count(), 0, 'no textarea');
        assert.equal(await page.locator('textarea').count(), 0, 'no textarea anywhere');
        assert.match((await page.locator('.exam__onpaper').textContent()) ?? '', /Answer this question on your answer paper/);
      });
      await check('the palette is honest: theory is counted as on paper, not as answered on screen', async () => {
        assert.match((await page.locator('.exam__palette .muted').first().textContent()) ?? '', /0 of 2 answered on screen · 2 on paper/);
      });
      await check('answering an objective question still works and counts on screen', async () => {
        await page.locator('.pal').nth(0).click(); await page.locator('button.opt').first().click();
        await page.waitForTimeout(1200);
        assert.match((await page.locator('.exam__palette .muted').first().textContent()) ?? '', /1 of 2 answered on screen · 2 on paper/);
      });
      await check('a forged request to type a theory answer is refused with 409 and stores nothing', async () => {
        const attemptId = await page.evaluate(() => (document.querySelector('[data-attempt-id]') as HTMLElement | null)?.dataset.attemptId ?? '');
        const id = attemptId || String((await db.select().from(schema.attempts).orderBy(schema.attempts.id))[0]!.id);
        const theoryId = Number((await db.select().from(schema.questions).where(eq(schema.questions.questionType, 'theory')))[0]!.id);
        const status = await page.evaluate(async ([attempt, q]: [string, number]) => (await fetch(`/api/exam/${attempt}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionId: q, text: 'forged' }) })).status, [id, theoryId] as [string, number]);
        assert.equal(status, 409);
        assert.equal((await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.questionId, theoryId))).filter((r) => r.textAnswer === 'forged').length, 0);
      });
      await check('submitting does not warn about unanswered theory (nothing to type)', async () => {
        let message = ''; page.removeAllListeners('dialog'); page.on('dialog', (d: any) => { message = d.message(); d.accept(); });
        await submit(page); assert.ok(!/unanswered/.test(message) || /^[1-9]\d* question/.test(message) === false || !/2 questions? unanswered/.test(message), message);
      });
      const page3 = await open(phone.token, 390); await roomOf(page3);
      await check('on a phone the notice is readable and nothing scrolls sideways', async () => {
        await page3.locator('.pal').nth(3).click(); const box = await page3.locator('.exam__onpaper').boundingBox();
        assert.ok(box && box.width <= 390 && box.width > 150, JSON.stringify(box));
        assert.ok(await page3.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
        await submit(page3);
      });
      const page2 = await open(blank.token); await roomOf(page2); await submit(page2);

      const t = await open(teacherToken); await t.goto(new URL('/portal/marking', base).href, { waitUntil: 'networkidle' });
      await check('the teacher still gets a script for every theory question of every student (3 x 2)', async () => {
        assert.equal(await t.locator('.eo-review-card').count(), 6);
      });
      await check('each script says it was answered on paper instead of "No answer given."', async () => {
        const text = (await t.locator('.school-dashboard').first().textContent()) ?? '';
        assert.equal((text.match(/Answered on paper\./g) ?? []).length, 6); assert.ok(!/No answer given\./.test(text));
      });
      await check('the teacher enters a mark and the script leaves the queue', async () => {
        const card = t.locator('.eo-review-card').first(); await card.locator('input[name="marks"]').fill('7.5'); await card.locator('button[type="submit"]').click();
        await t.waitForLoadState('networkidle'); await t.goto(new URL('/portal/marking', base).href, { waitUntil: 'networkidle' });
        assert.equal(await t.locator('.eo-review-card').count(), 5);
        assert.equal((await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.awardedMarks, '7.50'))).length, 1);
      });
      await check('a mark above the maximum is refused', async () => {
        const card = t.locator('.eo-review-card').first(); await card.locator('input[name="marks"]').evaluate((el: HTMLInputElement) => el.removeAttribute('max'));
        await card.locator('input[name="marks"]').fill('11'); await card.locator('button[type="submit"]').click(); await t.waitForURL(/error=/);
        await t.waitForLoadState('networkidle'); await t.locator('.eo-review-card').first().waitFor({ timeout: 10000 });
        assert.equal(await t.locator('.eo-review-card').count(), 5, 'the refused script is still waiting');
        assert.match((await t.locator('p.error').textContent()) ?? '', /between 0 and 10/);
      });

      // ── authoring ── The sitting is over, so the exam office reopens the question bank (a published series would
      // correctly refuse edits: "This submission window is not open.").
      await db.update(schema.examSeries).set({ status: 'open' }).where(eq(schema.examSeries.id, Number(series.id)));
      const a = await open(teacherToken); // A scope is only resolved to a set (and the stored flag shown) once the page carries its setId, exactly as
      // after the selector's own submit. So pass the real set id for the scope being opened.
      const bank = async (q: string) => {
        const type = /examType=theory/.test(q) ? 'theory' : 'objective';
        const row = (await db.select().from(schema.questionSets).where(eq(schema.questionSets.schoolId, schoolId))).find((r) => r.examType === type);
        await a.goto(new URL(`/portal/questions?${q}&setId=${row?.id ?? ''}`, base).href, { waitUntil: 'networkidle' });
      };
      const common = `subjectId=${subject!.id}&levelId=${level!.id}&delivery=cbt&marks=1&method=manual`;
      await check('authoring: the "answered on paper" box appears for a CBT THEORY set and shows the stored value', async () => {
        await bank(`${common}&examType=theory`); const box = a.locator('input[name="theoryOnPaperBox"]');
        assert.equal(await box.count(), 1); assert.equal(await box.isChecked(), true);
      });
      await check('authoring: it is NOT offered for an objective set', async () => {
        await bank(`${common}&examType=objective`); assert.equal(await a.locator('input[name="theoryOnPaperBox"]').count(), 0);
      });
      await check('authoring: it is greyed out and explained once the set has been handed in', async () => {
        await bank(`${common}&examType=theory`); const box = a.locator('input[name="theoryOnPaperBox"]');
        assert.equal(await box.isDisabled(), true); assert.match((await a.locator('.qs-field--onpaper .qs-hint').textContent()) ?? '', /handed in/);
      });
      await check('authoring: on a draft set the teacher can untick it and the change is saved', async () => {
        await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.id, tset!.id));
        await bank(`${common}&examType=theory`); const box = a.locator('input[name="theoryOnPaperBox"]'); assert.equal(await box.isDisabled(), false);
        await box.uncheck(); await a.waitForLoadState('networkidle');
        for (let i = 0; i < 40; i++) { const row = (await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, tset!.id)))[0]!; if (!row.theoryOnPaper) break; await a.waitForTimeout(250); }
        assert.equal((await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, tset!.id)))[0]!.theoryOnPaper, false);
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
