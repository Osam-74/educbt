/**
 * Theory CHOICE in a real browser: the teacher decides how many theory questions each student answers and which are
 * compulsory; students see only what they were dealt, typed or on paper, on a desktop and on a phone. LOCAL disposable
 * database and local server only.
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs npx tsx src/db/test-theory-choice-browser.ts
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
  const schools: number[] = []; let checks = 0; const failed: string[] = [];
  async function check(name: string, test: () => Promise<unknown>) { try { await test(); checks++; console.log("PASS  " + name); } catch (e) { failed.push(name); console.log("FAIL  " + name + " :: " + String((e as Error).message).split("\n")[0]?.slice(0, 90)); } }
  const sessionFor = async (userId: number) => { const token = randomUUID() + randomUUID();
    await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId, expiresAt: new Date(Date.now() + 3600000) }); return token; };

  // Five theory questions; the teacher asks each student for three and ticks two (the 2nd and 5th) compulsory.
  const THEORY = 5, ANSWER = 3, COMPULSORY = [2, 5], OBJ = 2; // the paper asks each student for 2 objective questions

  try {
    const [school] = await db.insert(schema.schools).values({ name: 'Theory choice browser', code: 'TCB-' + randomUUID() }).returning(); const schoolId = school!.id; schools.push(schoolId);
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
    const [tset] = await db.insert(schema.questionSets).values({ ...base0, examType: 'theory', status: 'approved', theoryAnswerCount: ANSWER }).returning();
    const theoryIds: number[] = [];
    for (let i = 1; i <= THEORY; i++) {
      const [q] = await db.insert(schema.questions).values({ schoolId, questionSetId: tset!.id, questionText: `Explain theory topic ${i}.`, questionType: 'theory', sequence: 100 + i, approvalStatus: 'approved', status: 'active', marks: '10', isCompulsory: COMPULSORY.includes(i) } as never).returning();
      theoryIds.push(Number(q!.id));
    }
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
    const teacherToken = await sessionFor(teacher.user.id);

    const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
    const browser = await chromium.launch({ headless: true }); const errors: string[] = [];
    const open = async (token: string, width = 1100) => {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
      const page = await ctx.newPage(); page.on('pageerror', (e: Error) => errors.push(e.message)); page.on('dialog', (d: any) => d.accept()); return page;
    };
    const roomOf = (page: any) => page.goto(new URL(`/exam/${paper!.id}`, base).href, { waitUntil: 'networkidle' });
    /** What the student sees for theory question number n of the palette: its text and the rule line above it. */
    const theoryPalette = async (page: any) => {
      const total = await page.locator('.pal').count(); const seen: Array<{ text: string; rule: string }> = [];
      for (let i = OBJ; i < total; i++) {
        await page.locator('.pal').nth(i).click();
        seen.push({ text: ((await page.locator('.exam__text').textContent()) ?? '').trim(), rule: ((await page.locator('[data-testid="theory-rule"]').first().textContent().catch(() => '')) ?? '').trim() });
      }
      return { total, seen };
    };
    const topicOf = (t: string) => Number(/topic (\d+)/.exec(t)?.[1] ?? 0);

    try {
      // ── STUDENT, typed, desktop ───────────────────────────────────────────────────────────────────────────────
      const typed = await mkStudent('typed'); const page = await open(typed.token); await roomOf(page);
      let dealt: number[] = [];
      await check('typed/desktop: the student has 2 objective + exactly 3 theory questions (not all 5)', async () => {
        const r = await theoryPalette(page); assert.equal(r.total, OBJ + ANSWER); dealt = r.seen.map((s) => topicOf(s.text)); assert.equal(new Set(dealt).size, ANSWER);
      });
      await check('typed/desktop: both compulsory questions are among them, and theory is in the order the teacher wrote', async () => {
        for (const c of COMPULSORY) assert.ok(dealt.includes(c), `compulsory topic ${c} missing from ${dealt}`);
        assert.deepEqual(dealt, [...dealt].sort((a, b) => a - b));
      });
      await check('typed/desktop: every theory question says "Answer all 3 of the theory questions on this paper"', async () => {
        const r = await theoryPalette(page); for (const s of r.seen) assert.match(s.rule, /Answer all 3 of the theory questions on this paper/);
      });
      await check('typed/desktop: a compulsory question is labelled, an optional one is not', async () => {
        const r = await theoryPalette(page);
        for (const s of r.seen) { const c = COMPULSORY.includes(topicOf(s.text)); assert.equal(/This question is compulsory/.test(s.rule), c, `${s.text} -> ${s.rule}`); }
      });
      await check('typed/desktop: there IS an answer box for each theory question and it keeps what the student types', async () => {
        await page.locator('.pal').nth(OBJ).click(); const box = page.locator('textarea.exam__theory'); assert.equal(await box.count(), 1);
        await box.fill('My typed answer'); await box.blur(); await page.waitForTimeout(1800);
        const [row] = (await db.select().from(schema.attemptAnswers)).filter((r) => r.textAnswer === 'My typed answer'); assert.ok(row, 'the answer reached the database');
      });
      await check('typed/desktop: the palette counts what was dealt (3 theory), not what was written (5)', async () => {
        assert.match((await page.locator('.exam__palette .muted').first().textContent()) ?? '', /of 5 answered/);
      });

      // ── STUDENT, on paper, phone ──────────────────────────────────────────────────────────────────────────────
      await db.update(schema.examPapers).set({ theoryOnPaper: true }).where(eq(schema.examPapers.id, paper!.id));
      const onpaper = await mkStudent('onpaper'); const phone = await open(onpaper.token, 390); await roomOf(phone);
      let dealt2: number[] = [];
      await check('on paper/phone: 3 theory questions again, with the compulsory two among them', async () => {
        const r = await theoryPalette(phone); dealt2 = r.seen.map((s) => topicOf(s.text)); assert.equal(r.total, OBJ + ANSWER);
        for (const c of COMPULSORY) assert.ok(dealt2.includes(c), String(dealt2));
      });
      await check('on paper/phone: the "answer all 3" line is shown in read-only mode too, and there is no answer box', async () => {
        const r = await theoryPalette(phone); for (const s of r.seen) assert.match(s.rule, /Answer all 3 of the theory questions/);
        assert.equal(await phone.locator('textarea').count(), 0);
      });
      await check('on paper/phone: the rule line fits the screen and nothing scrolls sideways', async () => {
        const box = await phone.locator('[data-testid="theory-rule"]').first().boundingBox();
        assert.ok(box && box.width <= 390 && box.width > 150, JSON.stringify(box));
        assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no sideways page scroll');
      });
      await db.update(schema.examPapers).set({ theoryOnPaper: false }).where(eq(schema.examPapers.id, paper!.id));

      // ── STUDENTS DIFFER ───────────────────────────────────────────────────────────────────────────────────────
      await check('different students get different optional questions (the pick is random), but always the compulsory two', async () => {
        const sets = new Set<string>();
        for (let i = 0; i < 8; i++) { const s = await mkStudent('rnd' + i); const p = await open(s.token); await roomOf(p); const r = await theoryPalette(p);
          const topics = r.seen.map((x) => topicOf(x.text)); for (const c of COMPULSORY) assert.ok(topics.includes(c)); sets.add(topics.join(',')); await p.context().close(); }
        assert.ok(sets.size >= 2, `all 8 students got the same ${[...sets][0]}`);
      });
      await check('a paper where the teacher chose no number shows NO rule line (exactly as before)', async () => {
        await db.update(schema.examPapers).set({ theoryAnswerCount: 0 }).where(eq(schema.examPapers.id, paper!.id));
        const s = await mkStudent('plain'); const p = await open(s.token); await roomOf(p); const r = await theoryPalette(p);
        assert.equal(r.total, OBJ + THEORY, 'every theory question is dealt'); for (const x of r.seen) assert.equal(x.rule, '');
      });
      await db.update(schema.examPapers).set({ theoryAnswerCount: ANSWER }).where(eq(schema.examPapers.id, paper!.id));

      // ── TEACHER authoring ─────────────────────────────────────────────────────────────────────────────────────
      await db.update(schema.examSeries).set({ status: 'open' }).where(eq(schema.examSeries.id, Number(series.id)));
      await db.update(schema.questionSets).set({ status: 'draft' }).where(eq(schema.questionSets.id, tset!.id));
      const a = await open(teacherToken);
      const bank = async () => { await a.goto(new URL(`/portal/questions?subjectId=${subject!.id}&levelId=${level!.id}&delivery=cbt&marks=1&method=manual&examType=theory&setId=${tset!.id}`, base).href, { waitUntil: 'networkidle' }); };
      const settle = async () => { await a.waitForLoadState('networkidle'); await a.waitForTimeout(1200); };
      await check('teacher: the "how many does each student answer" box shows the saved number', async () => {
        await bank(); assert.equal(await a.locator('#qs-answer-count').inputValue(), String(ANSWER));
      });
      await check('teacher: the list shows a Compulsory badge on exactly the two ticked questions', async () => {
        await bank(); assert.equal(await a.locator('[data-testid="compulsory-badge"]').count(), COMPULSORY.length);
      });
      await check('teacher: the banner says how many are written and how many each student answers, with no fixed minimum', async () => {
        const text = (await a.locator('p.muted, p.short').first().textContent()) ?? '';
        assert.match(text, /5 theory questions written\. Each student answers 3, including the 2 marked compulsory\./); assert.ok(!/more needed/.test(text), text);
      });
      await check('teacher: changing the number saves it, and it survives a reload', async () => {
        const box = a.locator('#qs-answer-count'); await box.fill('4'); await box.blur(); await settle();
        const [row] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, tset!.id)); assert.equal(row!.theoryAnswerCount, 4);
        await bank(); assert.equal(await a.locator('#qs-answer-count').inputValue(), '4');
      });
      await check('teacher: clearing the box means every student answers all of them', async () => {
        const box = a.locator('#qs-answer-count'); await box.fill(''); await box.blur(); await settle();
        const [row] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, tset!.id)); assert.equal(row!.theoryAnswerCount, 0);
        await bank(); assert.match((await a.locator('p.muted, p.short').first().textContent()) ?? '', /Each student answers all of them/);
      });
      await check('teacher: asking for more than were written is explained on the page', async () => {
        const box = a.locator('#qs-answer-count'); await box.fill('9'); await box.blur(); await settle(); await bank();
        assert.match((await a.locator('p.short').first().textContent()) ?? '', /answers 9 theory questions, but only 5 are written/);
        assert.equal(await a.locator('button:has-text("Submit for review")').count(), 0, 'cannot hand in while the number is too high');
      });
      await check('teacher: more ticked than answered gives a notice that says what will happen', async () => {
        const box = a.locator('#qs-answer-count'); await box.fill('1'); await box.blur(); await settle(); await bank();
        assert.match((await a.locator('[data-testid="compulsory-notice"]').textContent()) ?? '', /2 questions are ticked compulsory but each student answers 1.*they will answer 2/);
      });
      await check('teacher: a question can be made compulsory from the list, and made optional again', async () => {
        const [first] = await db.select().from(schema.questions).where(eq(schema.questions.questionSetId, tset!.id)).orderBy(schema.questions.sequence);
        assert.equal(first!.isCompulsory, false); await bank();
        await a.locator(`[data-testid="compulsory-toggle-${first!.id}"]`).click(); await settle();
        assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.id, first!.id)))[0]!.isCompulsory, true);
        await bank(); await a.locator(`[data-testid="compulsory-toggle-${first!.id}"]`).click(); await settle();
        assert.equal((await db.select().from(schema.questions).where(eq(schema.questions.id, first!.id)))[0]!.isCompulsory, false);
      });
      await check('teacher: a new question can be saved as compulsory from the form', async () => {
        await bank(); await a.locator('#text').fill('A brand new compulsory theory question'); await a.locator('input[type="checkbox"][name="isCompulsory"]').check();
        await a.locator('button:has-text("Save question")').click(); await settle();
        const row = (await db.select().from(schema.questions).where(eq(schema.questions.questionSetId, tset!.id))).find((q) => q.questionText.startsWith('A brand new'));
        assert.ok(row, 'saved'); assert.equal(row!.isCompulsory, true);
      });
      await check('teacher: the box and the tick are greyed out or gone once the set is handed in', async () => {
        await db.update(schema.questionSets).set({ status: 'submitted' }).where(eq(schema.questionSets.id, tset!.id)); await bank();
        assert.equal(await a.locator('#qs-answer-count').isDisabled(), true); assert.equal(await a.locator('[data-testid^="compulsory-toggle-"]').count(), 0);
      });
      await check('teacher: an objective set shows none of this', async () => {
        const [o] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, oset!.id));
        await a.goto(new URL(`/portal/questions?subjectId=${subject!.id}&levelId=${level!.id}&delivery=cbt&marks=1&method=manual&examType=objective&setId=${o!.id}`, base).href, { waitUntil: 'networkidle' });
        assert.equal(await a.locator('#qs-answer-count').count(), 0); assert.equal(await a.locator('input[type="checkbox"][name="isCompulsory"]').count(), 0);
      });
      await check('no page error was thrown anywhere', async () => { assert.deepEqual(errors, []); });
    } finally { await browser.close(); }
    if (failed.length > 0) { console.log(`\nFAILED: ${checks} passed, ${failed.length} failed`); process.exitCode = 1; } else console.log(`\nOK: ${checks} passed, 0 failed`);
  } finally {
    for (const id of schools) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
