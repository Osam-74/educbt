import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, client, forSchool } = await import('@/db');
  const { findOrCreateSet, addQuestion, submitSet, reviewSet } = await import('@/lib/exam/sets');
  const { saveCollection } = await import('@/lib/exam/collection');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const db = drizzle(owner, { schema });
  const ids: number[] = []; let checks = 0;
  async function check(name: string, test: () => Promise<unknown>) { await test(); checks++; console.log('PASS  ' + name); }
  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Question Bank test', code: 'QB-' + randomUUID() }).returning();
    const schoolId = school!.id; ids.push(schoolId);
    const actors: Record<string, Actor> = {};
    for (const name of ['principal', 'teacher', 'other', 'student']) {
      const role = name === 'other' ? 'teacher' : name as 'principal' | 'teacher' | 'student';
      const [user] = await db.insert(schema.users).values({ schoolId, role, loginId: name, passwordHash: 'unused', mustChangePassword: false }).returning();
      const [staff] = role === 'student' ? [] : await db.insert(schema.staff).values({ schoolId, userId: user!.id, role, staffNumber: name, firstName: 'Test', lastName: name }).returning();
      actors[name] = { schoolId, userId: user!.id, role, staffId: staff?.id ?? null, studentId: null, loginId: name };
    }
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1 }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'ENG', name: 'English' }).returning();
    const [room] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 A' }).returning();
    for (const name of ['teacher', 'other']) await db.insert(schema.staffAssignments).values({ schoolId, staffId: actors[name]!.staffId!, subjectId: subject!.id, classId: room!.id });
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'First term',
      questionsOpenFrom: new Date(Date.now() - 86400000), questionsOpenTo: new Date(Date.now() + 86400000) }).returning();
    return { schoolId, actors, series: series!, scope: { sessionId: session!.id, termId: term!.id, subjectId: subject!.id,
      levelId: level!.id, departmentId: null, seriesId: 0, examType: 'objective' as const, waecMode: false } };
  }
  try {
    const a = await fixture(); const b = await fixture();
    const principal = a.actors.principal!, teacher = a.actors.teacher!;
    await check('closed bank blocks creation', () => assert.rejects(findOrCreateSet(teacher, a.scope), /closed/));
    await check('teacher cannot configure collection', () => assert.rejects(saveCollection(teacher, { objective: 1, theory: 1, seriesId: a.series.id }), /exam office/));
    await check('foreign collection rejected', () => assert.rejects(saveCollection(principal, { objective: 1, theory: 1, seriesId: b.series.id })));
    await saveCollection(principal, { objective: 1, theory: 1, seriesId: a.series.id });
    await check('expired window blocks service writes', async () => {
      await db.update(schema.examSeries).set({ questionsOpenTo: new Date(Date.now() - 1000) }).where(eq(schema.examSeries.id, a.series.id));
      await assert.rejects(findOrCreateSet(teacher, a.scope), /not open/);
      await db.update(schema.examSeries).set({ questionsOpenTo: a.series.questionsOpenTo }).where(eq(schema.examSeries.id, a.series.id));
    });
    await check('student cannot create a set', () => assert.rejects(findOrCreateSet(a.actors.student!, a.scope)));
    await check('cross-school scope rejected', () => assert.rejects(findOrCreateSet(teacher, b.scope)));
    const set = await findOrCreateSet(teacher, a.scope);
    await check('configured quota applied', async () => assert.equal(set.minRequired, 1));
    await check('same scope is idempotent', async () => assert.equal((await findOrCreateSet(teacher, a.scope)).id, set.id));
    await check('other teacher cannot take over set', () => assert.rejects(findOrCreateSet(a.actors.other!, a.scope), /another teacher/));
    await check('other teacher cannot submit set', () => assert.rejects(submitSet(a.actors.other!, set.id), /another teacher/));
    await check('revoked subject assignment blocks authoring', async () => {
      await db.update(schema.staffAssignments).set({ status: 'inactive' }).where(eq(schema.staffAssignments.staffId, teacher.staffId!));
      await assert.rejects(findOrCreateSet(teacher, a.scope), /not assigned/);
      await db.update(schema.staffAssignments).set({ status: 'active' }).where(eq(schema.staffAssignments.staffId, teacher.staffId!));
    });
    const input = { text: 'Which number is even?', marks: 1, options: [{ text: 'Two', isCorrect: true }, { text: 'Three', isCorrect: false }] };
    await check('invalid answer combination rejected by service', () => assert.rejects(addQuestion(teacher, set.id, { ...input, options: input.options.map(o => ({ ...o, isCorrect: true })) })));
    await addQuestion(teacher, set.id, input);
    await check('duplicate question rejected', () => assert.rejects(addQuestion(teacher, set.id, input), /already exists/));
    await check('incomplete paired set returns shortfall', async () => assert.equal((await submitSet(teacher, set.id)).success, false));
    const theory = await findOrCreateSet(teacher, { ...a.scope, examType: 'theory' });
    await addQuestion(teacher, theory.id, { text: 'Explain what even numbers are.', marks: 5 });
    await check('complete pair submits', async () => assert.equal((await submitSet(teacher, set.id)).success, true));
    await check('submitted set cannot be edited', () => assert.rejects(addQuestion(teacher, set.id, { ...input, text: 'Another valid question?' }), /submitted/));
    await check('teacher cannot approve own work', () => assert.rejects(reviewSet(teacher, set.id, 'approve', ''), /exam office/));
    await reviewSet(principal, set.id, 'approve', '');
    await check('approved set cannot be reopened via review', () => assert.rejects(reviewSet(principal, set.id, 'return', 'Please revise this question.'), /submitted/));
    await check('returned half resubmits without changing approved partner', async () => {
      await reviewSet(principal, theory.id, 'return', 'Please clarify the marking instructions.');
      assert.equal((await submitSet(teacher, theory.id)).success, true);
      const [partner] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, set.id));
      assert.equal(partner!.status, 'approved');
    });
    await check('quota changes preserve submitted requirements', async () => {
      await saveCollection(principal, { objective: 30, theory: 6, seriesId: a.series.id });
      const [row] = await db.select().from(schema.questionSets).where(eq(schema.questionSets.id, set.id)); assert.equal(row!.minRequired, 1);
    });
    await check('tenant RLS hides foreign sets', async () => assert.equal((await forSchool(b.schoolId, tx => tx.select().from(schema.questionSets).where(eq(schema.questionSets.id, set.id)))).length, 0));
    await check('configuration audit includes before/after', async () => {
      const [row] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, a.schoolId), eq(schema.auditLog.action, 'question_bank.configured')));
      assert(row?.before && row.after);
    });
    if (process.env.CA_TEST_HTTP_URL) {
      const [practice] = await db.insert(schema.examSeries).values({ schoolId: a.schoolId, sessionId: a.scope.sessionId,
        termId: a.scope.termId, title: 'Practice collection', seriesType: 'practice' }).returning();
      const base = new URL(process.env.CA_TEST_HTTP_URL);
      assert(['127.0.0.1', 'localhost'].includes(base.hostname));
      assert(process.env.QUESTION_BROWSER_MODULE, 'HTTP verification requires a browser runtime');
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: principal.userId, expiresAt: new Date(Date.now() + 600000) });
      const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE);
      const browser = await chromium.launch({ headless: true, ...(process.env.QUESTION_BROWSER_EXECUTABLE ? { executablePath: process.env.QUESTION_BROWSER_EXECUTABLE } : {}) });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
        const page = await context.newPage(); const errors: string[] = [];
        page.on('pageerror', (error: Error) => errors.push(error.message));
        await mkdir('baseline-logs', { recursive: true });
        await page.goto(new URL('/portal/questions', base).href, { waitUntil: 'networkidle' });
        await check('desktop bank controls render without overflow', async () => {
          await page.getByRole('heading', { name: 'Question bank', exact: true }).waitFor();
          await page.getByText('Collection window & authoring quotas', { exact: true }).click();
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: 'baseline-logs/question-bank-desktop.png', fullPage: true });
        });
        await check('collection save works through server action', async () => {
          await page.getByLabel('Objective target', { exact: true }).fill('25');
          await page.getByRole('button', { name: 'Save collection', exact: true }).click();
          await page.getByRole('status').filter({ hasText: 'Collection saved' }).waitFor();
        });
        await check('invalid collection/type shows actionable error', async () => {
          await page.getByLabel('Collection', { exact: true }).selectOption(String(practice!.id));
          await page.getByLabel('Question type', { exact: true }).selectOption('theory');
          await page.getByRole('button', { name: 'Open question set', exact: true }).click();
          await page.getByRole('alert').filter({ hasText: 'objective questions only' }).waitFor();
          await page.screenshot({ path: 'baseline-logs/question-bank-validation.png', fullPage: true });
        });
        await check('start-set form reaches authoring route', async () => {
          await page.getByLabel('Collection', { exact: true }).selectOption(String(practice!.id));
          await page.getByLabel('Question type', { exact: true }).selectOption('objective');
          await page.getByRole('button', { name: 'Open question set', exact: true }).click();
          await page.getByRole('heading', { name: 'Add a question', exact: true }).waitFor();
          assert(/\/portal\/questions\/\d+$/.test(page.url()));
          await page.goto(new URL('/portal/questions', base).href, { waitUntil: 'networkidle' });
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await check('mobile bank remains within viewport', async () => {
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: 'baseline-logs/question-bank-mobile.png', fullPage: true });
        });
        await check('browser has no runtime errors', async () => assert.deepEqual(errors, []));
      } finally { await browser.close(); }
    }
  } finally {
    for (const id of ids) await db.delete(schema.schools).where(eq(schema.schools.id, id));
    await owner.end(); await client.end();
  }
  console.log(`${checks} Question Bank service checks passed`);
}
main().catch(error => { console.error(error); process.exit(1); });
