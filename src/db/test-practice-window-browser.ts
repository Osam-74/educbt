/**
 * Limited-time practice in a real browser: the exam officer sets when it is open (in the SCHOOL's time zone), and the
 * student sees whether it is open, not open yet or closed, and can only start it while it is open.
 * LOCAL disposable database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-practice-window-browser.ts
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
  const { createSeries, composeSeries, publishSeries, setPracticeWindow } = await import('@/lib/exam/compose');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  let schoolId = 0, checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  const DAY = 86400000;
  const settle = async (ok: () => Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ok()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };
  try {
    const [school] = await db.insert(schema.schools).values({ name: 'Practice window UI', code: 'PU-' + randomUUID() }).returning(); schoolId = school!.id;
    const mkUser = async (role: 'exam_officer' | 'teacher' | 'student', login: string) => {
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: login, passwordHash: 'unused', mustChangePassword: false }).returning();
      if (role === 'student') return { user: user!, staff: null as null };
      const [staff] = await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: login, firstName: 'T', lastName: login }).returning();
      return { user: user!, staff: staff! };
    };
    const officerU = await mkUser('exam_officer', 'officer'), teacherU = await mkUser('teacher', 'teacher'), studentU = await mkUser('student', 'student1');
    const officer: Actor = { schoolId, userId: officerU.user.id, role: 'exam_officer', staffId: officerU.staff!.id, studentId: null, loginId: 'officer' };
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027', isCurrent: true }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, isCurrent: true }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'SS2', stage: 'senior' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'SS2 A' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English Language' }).returning();
    const [student] = await db.insert(schema.students).values({ schoolId, userId: studentU.user.id, admissionNumber: 'A' + randomUUID().slice(0, 6), firstName: 'Ada', lastName: 'Student', classId: room!.id } as never).returning();
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: student!.id, subjectId: subject!.id, sessionId: session!.id, termId: term!.id } as never);
    const series = await createSeries(officer, { title: 'WAEC English practice', seriesType: 'practice', sessionId: session!.id, termId: term!.id, questionsPerStudent: 2, durationMinutes: 30 });
    const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id, subjectId: subject!.id, levelId: level!.id,
      examType: 'objective', seriesId: Number(series.id), status: 'approved', teacherId: teacherU.staff!.id, waecMode: true }).returning();
    for (let i = 0; i < 3; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: `Practice question ${i}?`, sequence: i + 1, approvalStatus: 'approved' }).returning();
      await db.insert(schema.questionOptions).values([{ schoolId, questionId: q!.id, optionKey: 'A', optionText: 'Yes', isCorrect: true, sortOrder: 0 }, { schoolId, questionId: q!.id, optionKey: 'B', optionText: 'No', isCorrect: false, sortOrder: 1 }]);
    }
    await composeSeries(officer, Number(series.id));
    const [paper] = await db.select().from(schema.examPapers).where(eq(schema.examPapers.seriesId, Number(series.id)));
    const sid = Number(series.id), paperId = Number(paper!.id);
    const seriesRow = async () => (await db.select().from(schema.examSeries).where(eq(schema.examSeries.id, sid)))[0]!;

    const login = async (userId: number) => {
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId, expiresAt: new Date(Date.now() + 1800000) });
      return token;
    };
    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true });
    try {
      const mk = async (token: string, width = 1280) => {
        const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
        await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
        const page = await ctx.newPage(); const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
        return { page, errors };
      };
      const off = await mk(await login(officerU.user.id)), stu = await mk(await login(studentU.user.id));
      const seriesUrl = new URL(`/portal/exams/${sid}`, base).href, practiceUrl = new URL('/portal/practice', base).href;

      await check('the officer sees the opening-times section for a practice paper, and "open all the time" by default', async () => {
        await off.page.goto(seriesUrl, { waitUntil: 'networkidle' });
        await off.page.getByTestId('practice-window').waitFor();
        assert.match((await off.page.getByTestId('practice-window-now').textContent()) ?? '', /open all the time/);
        assert.equal(await off.page.getByRole('button', { name: 'Open all the time' }).count(), 0, 'nothing to clear yet');
      });
      await check('an unpublished practice paper is not on the student page at all', async () => {
        await stu.page.goto(practiceUrl, { waitUntil: 'networkidle' });
        assert.equal(await stu.page.locator(`[data-testid="window-note-${paperId}"], a[href="/exam/${paperId}"]`).count(), 0);
        assert.match((await stu.page.locator('main').innerText()), /No practice papers yet/);
      });
      await publishSeries(officer, sid);

      await check('the officer saves a window, and it is stored as the SCHOOL\'s local time (Lagos is UTC+1)', async () => {
        await off.page.goto(seriesUrl, { waitUntil: 'networkidle' });
        await off.page.locator('#opensAt').fill('2030-03-10T09:00'); await off.page.locator('#closesAt').fill('2030-03-12T17:30');
        await off.page.getByRole('button', { name: 'Save times' }).click();
        await off.page.getByText('Practice opening times saved.').waitFor();
        const row = await seriesRow();
        assert.equal(row.sittingOpensAt!.toISOString(), '2030-03-10T08:00:00.000Z', '09:00 in Lagos is 08:00 UTC');
        assert.equal(row.sittingClosesAt!.toISOString(), '2030-03-12T16:30:00.000Z');
      });
      await check('the saved times come back in the boxes exactly as typed, and the summary says them in local time', async () => {
        assert.equal(await off.page.locator('#opensAt').inputValue(), '2030-03-10T09:00');
        assert.equal(await off.page.locator('#closesAt').inputValue(), '2030-03-12T17:30');
        const now = (await off.page.getByTestId('practice-window-now').textContent()) ?? '';
        assert.match(now, /9:00 am/i); assert.match(now, /5:30 pm/i);
      });
      await check('before it opens the student sees "Opens ..." and no Start button', async () => {
        await stu.page.goto(practiceUrl, { waitUntil: 'networkidle' });
        assert.match((await stu.page.getByTestId(`window-note-${paperId}`).textContent()) ?? '', /Opens .*9:00 am/i);
        assert.equal(await stu.page.getByTestId(`window-not_open-${paperId}`).count(), 1);
        assert.equal(await stu.page.getByRole('link', { name: 'Start Practice' }).count(), 0);
      });
      await check('going straight to the paper before it opens is refused, in practice wording', async () => {
        await stu.page.goto(new URL(`/exam/${paperId}`, base).href, { waitUntil: 'networkidle' });
        assert.match(await stu.page.locator('body').innerText(), /practice paper is not open yet/i);
        assert.equal((await db.select().from(schema.attempts).where(eq(schema.attempts.paperId, paperId))).length, 0);
      });
      await check('while it is open the student sees "Open until ..." and can start', async () => {
        await setPracticeWindow(officer, sid, { opensAt: new Date(Date.now() - DAY).toISOString(), closesAt: new Date(Date.now() + DAY).toISOString() });
        await stu.page.goto(practiceUrl, { waitUntil: 'networkidle' });
        assert.match((await stu.page.getByTestId(`window-note-${paperId}`).textContent()) ?? '', /Open until/);
        await stu.page.getByRole('link', { name: 'Start Practice' }).waitFor();
      });
      await check('after it closes the student sees "Closed ..." and no Start button, and the paper refuses', async () => {
        await setPracticeWindow(officer, sid, { opensAt: new Date(Date.now() - 3 * DAY).toISOString(), closesAt: new Date(Date.now() - DAY).toISOString() });
        await stu.page.goto(practiceUrl, { waitUntil: 'networkidle' });
        assert.match((await stu.page.getByTestId(`window-note-${paperId}`).textContent()) ?? '', /Closed/);
        assert.equal(await stu.page.getByRole('link', { name: 'Start Practice' }).count(), 0);
        await stu.page.goto(new URL(`/exam/${paperId}`, base).href, { waitUntil: 'networkidle' });
        assert.match(await stu.page.locator('body').innerText(), /practice paper has closed/i);
      });
      await check('the officer can clear the window, and practice is open all the time again', async () => {
        await off.page.goto(seriesUrl, { waitUntil: 'networkidle' });
        await off.page.getByRole('button', { name: 'Open all the time' }).click();
        await off.page.getByText('Practice is open all the time again.').waitFor();
        assert.ok(await settle(async () => { const r = await seriesRow(); return r.sittingOpensAt === null && r.sittingClosesAt === null; }));
        await stu.page.goto(practiceUrl, { waitUntil: 'networkidle' });
        await stu.page.getByRole('link', { name: 'Start Practice' }).waitFor();
        assert.equal(await stu.page.getByTestId(`window-note-${paperId}`).count(), 0, 'no window note when there is no window');
      });
      await check('a window that closes before it opens is refused with a clear message and changes nothing', async () => {
        await off.page.goto(seriesUrl, { waitUntil: 'networkidle' });
        await off.page.locator('#opensAt').fill('2030-03-12T09:00'); await off.page.locator('#closesAt').fill('2030-03-10T09:00');
        await off.page.getByRole('button', { name: 'Save times' }).click();
        await off.page.getByText(/close after it opens/i).waitFor();
        const row = await seriesRow(); assert.equal(row.sittingOpensAt, null);
      });
      await check('the opening-times section is not shown for an examination', async () => {
        const exam = await createSeries(officer, { title: 'Terminal exam', seriesType: 'examination', sessionId: session!.id, termId: term!.id, questionsPerStudent: 2, durationMinutes: 30 });
        await off.page.goto(new URL(`/portal/exams/${exam.id}`, base).href, { waitUntil: 'networkidle' });
        assert.equal(await off.page.getByTestId('practice-window').count(), 0);
      });
      await check('a phone screen has no sideways scroll on either page', async () => {
        const phoneOff = await mk(await login(officerU.user.id), 390), phoneStu = await mk(await login(studentU.user.id), 390);
        for (const [p, url] of [[phoneOff.page, seriesUrl], [phoneStu.page, practiceUrl]] as const) {
          await p.goto(url, { waitUntil: 'networkidle' });
          assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), url);
        }
      });
      await check('the browser raised no runtime errors', async () => { assert.deepEqual(off.errors, []); assert.deepEqual(stu.errors, []); });
    } finally { await browser.close(); }
    console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    if (schoolId) await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
