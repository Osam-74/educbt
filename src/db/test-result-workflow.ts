/** Disposable local fixtures only; safe to run twice against the same database. */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { WAEC_NINE_POINT, DEFAULT_RANKING } from '@/domain/academic';
import { resultConfig } from '@/lib/results/config';
import type { Actor } from '@/lib/session';

async function main() {
  for (const name of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[name] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local *_ca_test database required');
  }
  const { schema, forSchool, client } = await import('@/db');
  const { compileClassResults, transitionClassResults, resultDashboard, resultOptions } = await import('@/lib/results/workflow');
  const { enterScore, compileSubject, transitionResults, awardMarks } = await import('@/lib/exam/results');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schools: number[] = [];
  let count = 0;
  const check = async (label: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + label); };
  const settings = { assessmentComponents: [
    { key: 'ca1', label: 'First CA', maxScore: 20, isExam: false },
    { key: 'ca2', label: 'Second CA', maxScore: 10, isExam: false },
    { key: 'exam', label: 'Examination', maxScore: 70, isExam: true },
  ], gradingScale: WAEC_NINE_POINT, rankingPolicy: DEFAULT_RANKING };
  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Workflow school', code: 'RW-' + randomUUID(), settings }).returning();
    const schoolId = school!.id; schools.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/2027' }).returning();
    const [term] = await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First term' }).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const classes = await db.insert(schema.classes).values(['A', 'B'].map(arm => ({ schoolId, levelId: level!.id, arm, displayName: 'JSS1 ' + arm }))).returning();
    const subjects = await db.insert(schema.subjects).values([{ schoolId, name: 'Mathematics', code: 'MTH' }, { schoolId, name: 'English', code: 'ENG' }]).returning();
    const users = await db.insert(schema.users).values((['principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent'] as const)
      .map(role => ({ schoolId, role, loginId: role, passwordHash: 'unused', mustChangePassword: false }))).returning();
    const actors = Object.fromEntries(users.map(u => [u.role, { schoolId, userId: u.id, role: u.role, loginId: u.loginId, staffId: null, studentId: null } as Actor]));
    const students = await db.insert(schema.students).values([1, 2, 3, 4].map(n => ({ schoolId, admissionNumber: String(n), firstName: 'Student', lastName: String(n) }))).returning();
    for (const [i, student] of students.entries()) {
      await db.insert(schema.enrollments).values({ schoolId, studentId: student.id, sessionId: session!.id, classId: classes[i === 3 ? 1 : 0]!.id });
      await db.insert(schema.studentSubjects).values({ schoolId, studentId: student.id, sessionId: session!.id, subjectId: subjects[0]!.id });
    }
    const [series] = await db.insert(schema.examSeries).values({ schoolId, sessionId: session!.id, termId: term!.id, title: 'Terminal', status: 'published' }).returning();
    const [set] = await db.insert(schema.questionSets).values({ schoolId, sessionId: session!.id, termId: term!.id,
      subjectId: subjects[0]!.id, levelId: level!.id, seriesId: series!.id, examType: 'objective' }).returning();
    const [question] = await db.insert(schema.questions).values({ schoolId, questionSetId: set!.id, questionText: 'Fixture', marks: '10' }).returning();
    const papers = await db.insert(schema.examPapers).values(classes.map(c => ({ schoolId, seriesId: series!.id, subjectId: subjects[0]!.id,
      classId: c.id, status: 'published' as const }))).returning();
    const attempts = [];
    for (const [i, student] of students.entries()) {
      const [attempt] = await db.insert(schema.attempts).values({ schoolId, paperId: papers[i === 3 ? 1 : 0]!.id, studentId: student.id,
        status: 'submitted', questionOrder: [question!.id], expiresAt: new Date() }).returning();
      attempts.push(attempt!);
      await db.insert(schema.attemptAnswers).values({ schoolId, attemptId: attempt!.id, questionId: question!.id, awardedMarks: i === 2 ? '0' : '8' });
    }
    const scope = { classId: classes[0]!.id, sessionId: session!.id, termId: term!.id };
    const save = (i: number, componentKey = 'ca1', score = 20) => enterScore(actors.principal!, {
      ...scope, classId: classes[i === 3 ? 1 : 0]!.id, subjectId: subjects[0]!.id, studentId: students[i]!.id,
      componentKey, score, maxScore: componentKey === 'ca1' ? 20 : 10 });
    return { schoolId, scope, actors, students, subjects, classes, attempts, papers, series: series!, question: question!, save };
  }
  try {
    await check('valid explicit school settings accepted', () => assert(resultConfig(settings)));
    for (const bad of [{}, { ...settings, gradingScale: undefined }, { ...settings, rankingPolicy: undefined },
      { ...settings, assessmentComponents: settings.assessmentComponents.slice(0, 2) },
      { ...settings, gradingScale: { ...WAEC_NINE_POINT, bands: [{ min: 50, grade: 'A', remark: 'Good' }] } }]) {
      await check('invalid or missing academic policy fails closed', () => assert.equal(resultConfig(bad), null));
    }
    const a = await fixture(); const b = await fixture(); const principal = a.actors.principal!;
    const compile = () => compileClassResults(principal, a.scope);
    const move = (to: Parameters<typeof transitionClassResults>[2], reason = '') => transitionClassResults(principal, a.scope, to, reason);
    const rows = () => db.select().from(schema.subjectResults).where(and(eq(schema.subjectResults.schoolId, a.schoolId), eq(schema.subjectResults.termId, a.scope.termId)));
    for (const role of ['teacher', 'student', 'parent', 'platform_admin', 'unknown']) {
      const actor = a.actors[role] ?? { ...principal, role };
      await check(role + ' cannot compile', () => assert.rejects(compileClassResults(actor, a.scope)));
      await check(role + ' cannot read results dashboard', () => assert.rejects(resultOptions(actor)));
    }
    await check('forged actor identity denied', () => assert.rejects(compileClassResults({ ...principal, userId: b.actors.principal!.userId }, a.scope)));
    await check('foreign academic scope denied', () => assert.rejects(compileClassResults(principal, b.scope)));
    await check('foreign term and class combination denied', () => assert.rejects(compileClassResults(principal, { ...a.scope, termId: b.scope.termId })));
    await check('uncompiled results cannot publish', () => assert.rejects(move('published')));
    await check('invalid destination denied', () => assert.rejects(move('bogus' as 'draft')));
    await check('legacy term-wide transition requires class', async () => assert.equal((await transitionResults(principal, a.scope.sessionId, a.scope.termId, 'published')).ok, false));
    await check('CA service supplies first component', async () => assert((await a.save(0)).ok));
    await check('partial CA stays incomplete after compilation', async () => {
      await compile(); const r = (await rows()).find(r => r.studentId === a.students[0]!.id)!;
      assert.equal(r.complete, false); assert.equal(r.subjectPosition, 0); assert.equal(r.caTotal, '20.00'); assert.equal(r.examTotal, '56.00');
    });
    await check('no result is created for an unoffered subject', async () => assert((await rows()).every(r => r.subjectId === a.subjects[0]!.id)));
    await check('incomplete cohort cannot be reviewed', () => assert.rejects(move('reviewed')));
    await check('compiled cannot skip review to publication', () => assert.rejects(move('published')));
    await check('compiled cannot skip to locked', () => assert.rejects(move('locked')));
    for (const i of [0, 1, 2, 3]) { assert((await a.save(i, 'ca1', i === 2 ? 0 : 20)).ok); assert((await a.save(i, 'ca2', i === 2 ? 0 : 10)).ok); }
    await check('exam officer can compile', () => compileClassResults(a.actors.exam_officer!, a.scope));
    await check('vice principal can recompile', () => compileClassResults(a.actors.vice_principal!, a.scope));
    await check('all components including real zero become complete', async () => assert((await rows()).every(r => r.complete)));
    await check('stored policy and scale explain totals and tied positions', async () => {
      const r = await rows(); assert.equal(r.length, 3); assert.deepEqual(r.map(r => r.total).sort(), ['0.00', '86.00', '86.00']);
      assert.deepEqual(r.map(r => r.subjectPosition).sort(), [1, 1, 3]); assert(r.every(r => r.gradingScaleId === 'waec-9' && r.gradingScaleVersion === 1));
    });
    await check('repeat compilation keeps same result row identities', async () => { const before = (await rows()).map(r => r.id).sort(); await compile(); assert.deepEqual((await rows()).map(r => r.id).sort(), before); });
    await check('single-subject API uses guarded compilation', () => compileSubject(principal, { ...a.scope, subjectId: a.subjects[0]!.id }));
    await check('partial compilation cannot authorize class sign-off', () => assert.rejects(move('reviewed')));
    await compile();
    for (const role of ['exam_officer', 'vice_principal']) await check(role + ' cannot sign off review', () => assert.rejects(transitionClassResults(a.actors[role]!, a.scope, 'reviewed')));
    await check('other class can compile independently', () => compileClassResults(principal, { ...a.scope, classId: a.classes[1]!.id }));
    await check('review changes only selected class', async () => { await move('reviewed'); const r = await rows(); assert.equal(r.find(r => r.studentId === a.students[3]!.id)!.state, 'compiled'); });
    await check('review does not alter marks', async () => assert.equal((await rows()).find(r => r.studentId === a.students[0]!.id)!.total, '86.00'));
    await check('reviewed result cannot be recompiled', () => assert.rejects(compile()));
    await check('reviewed CA entry is blocked', async () => assert.equal((await a.save(0)).ok, false));
    await check('review reversal requires written reason', () => assert.rejects(move('compiled')));
    await check('principal publishes reviewed results', () => move('published'));
    await check('published result cannot be recompiled', () => assert.rejects(compile()));
    await check('publication sets family visibility', async () => assert((await rows()).filter(r => r.studentId !== a.students[3]!.id).every(r => r.published)));
    await check('principal locks published results', () => move('locked'));
    await check('locked CA remains blocked', async () => assert.equal((await a.save(0)).ok, false));
    const [answer] = await db.select().from(schema.attemptAnswers).where(eq(schema.attemptAnswers.attemptId, a.attempts[0]!.id));
    await check('locked examination mark correction is refused', async () => assert.equal((await awardMarks(principal, answer!.id, 7)).ok, false));
    for (const role of ['exam_officer', 'vice_principal', 'teacher']) {
      await check(role + ' cannot unlock', () => assert.rejects(transitionClassResults(a.actors[role]!, a.scope, 'published', 'Attempted unlock by wrong role')));
    }
    await check('lock cannot skip straight to editable', () => assert.rejects(move('compiled', 'Correction for test')));
    await check('unlock requires a substantive reason', () => assert.rejects(move('published', 'short')));
    await check('principal unlock retains visibility', () => move('published', 'Correct a recorded assessment'));
    await check('withdraw publication requires reason', () => assert.rejects(move('reviewed')));
    await check('withdrawal returns to staff-only review', async () => { await move('reviewed', 'Correct a recorded assessment'); assert((await rows()).filter(r => r.studentId !== a.students[3]!.id).every(r => !r.published)); });
    await check('audited reopening permits corrections', async () => { await move('compiled', 'Correct a recorded assessment'); assert((await a.save(0, 'ca1', 19)).ok); });
    await check('changed CA prevents sign-off until recompiled', () => assert.rejects(move('reviewed')));
    await compile();
    await db.update(schema.schools).set({ settings: { ...settings, rankingPolicy: { ...DEFAULT_RANKING, tiePolicy: 'dense' } } }).where(eq(schema.schools.id, a.schoolId));
    await check('configuration change invalidates sign-off', () => assert.rejects(move('reviewed')));
    await check('stored school ranking policy is used on recompile', async () => { await compile(); assert((await rows()).filter(r => r.studentId !== a.students[3]!.id).every(r => r.rankingPolicy?.tiePolicy === 'dense')); });
    await db.update(schema.attemptAnswers).set({ awardedMarks: null }).where(eq(schema.attemptAnswers.attemptId, a.attempts[0]!.id));
    await check('unmarked theory or answer is incomplete', async () => assert.equal((await resultDashboard(principal, a.scope)).rows[0]!.examComplete, false));
    await check('mark changes invalidate review', () => assert.rejects(move('reviewed')));
    await db.update(schema.attemptAnswers).set({ awardedMarks: '8' }).where(eq(schema.attemptAnswers.attemptId, a.attempts[0]!.id));
    for (const status of ['in_progress', 'cancelled'] as const) {
      await db.update(schema.attempts).set({ status }).where(eq(schema.attempts.id, a.attempts[0]!.id));
      await check(status + ' exam is not complete', async () => assert.equal((await resultDashboard(principal, a.scope)).rows[0]!.examComplete, false));
    }
    await db.update(schema.attempts).set({ status: 'submitted' }).where(eq(schema.attempts.id, a.attempts[0]!.id));
    await db.update(schema.examSeries).set({ seriesType: 'practice' }).where(eq(schema.examSeries.id, a.series.id));
    await check('practice is excluded from academic results', async () => assert.equal((await resultDashboard(principal, a.scope)).rows[0]!.examComplete, false));
    await db.update(schema.examSeries).set({ seriesType: 'examination' }).where(eq(schema.examSeries.id, a.series.id));
    const [extra] = await db.insert(schema.examPapers).values({ schoolId: a.schoolId, seriesId: a.series.id, subjectId: a.subjects[0]!.id, classId: a.scope.classId, status: 'published' }).returning();
    await check('multiple exams surface missing aggregation policy', async () => assert((await resultDashboard(principal, a.scope)).rows[0]!.missing.some(m => m.includes('aggregation'))));
    await db.delete(schema.examPapers).where(eq(schema.examPapers.id, extra!.id));
    await compile();
    await check('examination correction invalidates compilation', async () => {
      assert((await awardMarks(principal, answer!.id, 7)).ok);
      assert.equal((await rows()).find(r => r.studentId === a.students[0]!.id)!.state, 'draft');
    });
    await check('student cannot mark an examination', async () => assert.equal((await awardMarks(a.actors.student!, answer!.id, 8)).ok, false));
    await check('non-finite examination mark refused', async () => assert.equal((await awardMarks(principal, answer!.id, NaN)).ok, false));
    assert((await awardMarks(principal, answer!.id, 8)).ok);
    await compile();
    await check('concurrent CA save makes waiting review fail closed', async () => {
      let reviewing: Promise<unknown>;
      await owner.begin(async held => {
        const key = ['educbt-results', a.schoolId, a.scope.sessionId, a.scope.termId].join(':');
        await held`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        reviewing = move('reviewed').then(() => { throw Error('Review unexpectedly succeeded'); }, () => true);
        let waiting = false;
        for (let i = 0; i < 100; i++) {
          const [lock] = await held`select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting`;
          if (lock!.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert(waiting);
        await held`update assessment_scores set score=18 where school_id=${a.schoolId} and student_id=${a.students[0]!.id} and component_key='ca1'`;
      });
      assert.equal(await reviewing!, true);
    });
    await compile();
    await check('audit records actor scope before after and correction reason', async () => {
      const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, a.schoolId));
      for (const action of ['results.compiled', 'results.reviewed', 'results.published', 'results.locked']) assert(audit.some(a => a.action === action && a.before && a.after && a.actorUserId));
      assert(audit.some(a => a.reason === 'Correct a recorded assessment'));
    });
    await check('other tenant cannot read any result', async () => assert.equal((await forSchool(b.schoolId, tx => tx.select().from(schema.subjectResults))).length, 0));
    await check('other tenant cannot transition this class', () => assert.rejects(transitionClassResults(b.actors.principal!, a.scope, 'reviewed')));
    await db.update(schema.schools).set({ status: 'suspended' }).where(eq(schema.schools.id, a.schoolId));
    await check('suspended school cannot compile', () => assert.rejects(compile()));
    await db.update(schema.schools).set({ status: 'active' }).where(eq(schema.schools.id, a.schoolId));
    if (process.env.CA_TEST_HTTP_URL) {
      const base = new URL(process.env.CA_TEST_HTTP_URL); assert(['localhost', '127.0.0.1'].includes(base.hostname));
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: principal.userId, expiresAt: new Date(Date.now() + 120000) });
      const url = new URL(`/portal/results?classId=${a.scope.classId}&termId=${a.scope.termId}`, base);
      const headers = { cookie: 'educbt.session=' + token };
      await check('HTTP unauthenticated results redirects', async () => assert.equal((await fetch(url, { redirect: 'manual' })).status, 307));
      await check('HTTP results renders class readiness and stored totals', async () => { const r = await fetch(url, { headers }); assert.equal(r.status, 200); const html = await r.text(); assert(html.includes('JSS1 A')); assert(html.includes('Review results')); assert(html.includes('Mathematics')); });
      await check('HTTP includes report and broadsheet links with term', async () => { const html = await (await fetch(url, { headers })).text(); assert(html.includes(`/portal/reports/${a.students[0]!.id}?term=`)); assert(html.includes('/portal/broadsheet?class=')); });
      const [laterSession] = await db.insert(schema.academicSessions).values({ schoolId: a.schoolId, title: '2027/2028' }).returning();
      const [laterTerm] = await db.insert(schema.terms).values({ schoolId: a.schoolId, sessionId: laterSession!.id, title: 'Later term' }).returning();
      await db.insert(schema.enrollments).values({ schoolId: a.schoolId, studentId: a.students[0]!.id, classId: a.classes[1]!.id, sessionId: laterSession!.id });
      await db.update(schema.students).set({ firstName: 'WrongSessionStudent' }).where(eq(schema.students.id, a.students[3]!.id));
      await check('HTTP report respects chosen term session enrollment', async () => {
        const html = await (await fetch(new URL(`/portal/reports/${a.students[0]!.id}?term=${laterTerm!.id}`, base), { headers })).text();
        assert(html.includes('2027/2028')); assert(html.includes('JSS1 B'));
      });
      await check('HTTP broadsheet excludes another session enrollment', async () => {
        const html = await (await fetch(new URL(`/portal/broadsheet?class=${a.classes[1]!.id}&term=${laterTerm!.id}`, base), { headers })).text();
        assert(!html.includes('WrongSessionStudent'));
      });
      await check('HTTP forged foreign scope has no result table', async () => { const bad = new URL(url); bad.searchParams.set('classId', String(b.scope.classId)); const html = await (await fetch(bad, { headers })).text(); assert(html.includes('academic scope is unavailable')); assert(!html.includes('Stored subject total')); });
      await db.update(schema.schools).set({ settings: {} }).where(eq(schema.schools.id, a.schoolId));
      await check('HTTP missing policy shows explicit setup guidance', async () => assert((await (await fetch(url, { headers })).text()).includes('Academic settings are incomplete or invalid')));
      if (process.env.RESULT_BROWSER_MODULE) {
        await db.update(schema.schools).set({ settings }).where(eq(schema.schools.id, a.schoolId));
        await compile();
        const { chromium } = await import(process.env.RESULT_BROWSER_MODULE);
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
          await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on('pageerror', (e: Error) => errors.push(e.message));
          await page.goto(url.href, { waitUntil: 'networkidle' });
          await check('browser desktop dashboard renders without runtime errors', async () => {
            await page.getByRole('heading', { name: 'Review results', exact: true }).waitFor();
            assert.deepEqual(errors, []);
            await page.screenshot({ path: 'baseline-logs/results-desktop.png', fullPage: true });
          });
          await check('browser principal signs off review through server action', async () => {
            await page.getByRole('button', { name: 'Sign off review', exact: true }).click();
            await page.getByText('3 subject results moved to reviewed.', { exact: true }).waitFor();
            assert.equal((await rows()).find(r => r.studentId === a.students[0]!.id)!.state, 'reviewed');
          });
          await check('browser mobile dashboard has no page overflow', async () => {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.screenshot({ path: 'baseline-logs/results-mobile.png', fullPage: true });
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
          });
          await check('browser publishes only after review', async () => {
            await page.getByRole('button', { name: 'Publish to students and parents', exact: true }).click();
            await page.getByText('3 subject results moved to published.', { exact: true }).waitFor();
          });
          await check('browser locks published results', async () => {
            await page.getByRole('button', { name: 'Lock results', exact: true }).click();
            await page.getByText('3 subject results moved to locked.', { exact: true }).waitFor();
          });
          await check('browser refuses unlock without correction reason', async () => {
            await page.getByRole('button', { name: 'Unlock results', exact: true }).click();
            await page.getByText('Provide a written correction reason of at least 10 characters.', { exact: true }).waitFor();
            assert.equal((await rows()).find(r => r.studentId === a.students[0]!.id)!.state, 'locked');
          });
          await check('browser accepts reasoned unlock and retains publication', async () => {
            await page.getByLabel('Written correction reason').fill('Correct the examination mark after review');
            await page.getByRole('button', { name: 'Unlock results', exact: true }).click();
            await page.getByText('3 subject results moved to published.', { exact: true }).waitFor();
            assert((await rows()).find(r => r.studentId === a.students[0]!.id)!.published);
            assert.deepEqual(errors, []);
          });
        } finally { await browser.close(); }
      }
    }
    console.log(`${count} PASS / 0 FAIL`);
  } finally {
    for (const id of schools) {
      await db.delete(schema.assessmentScores).where(eq(schema.assessmentScores.schoolId, id));
      await db.delete(schema.subjectResults).where(eq(schema.subjectResults.schoolId, id));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.schoolId, id));
      await db.delete(schema.schools).where(eq(schema.schools.id, id));
    }
    await owner.end(); await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
