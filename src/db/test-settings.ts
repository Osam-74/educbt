/** Uses only a disposable localhost *_ca_test database. All service calls use educbt_app. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { mkdir } from 'node:fs/promises';
import { defaultConfig } from '@/lib/settings/validation';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }
  const { schema, forSchool, client } = await import('@/db');
  const service = await import('@/lib/settings/service');
  const { saveManualRemark, snapshotRemarks, reportExtras } = await import('@/lib/settings/remarks');
  const { normalizeImage } = await import('@/lib/settings/images');
  const { default: sharp } = await import('sharp');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  async function check(name: string, fn: () => unknown | Promise<unknown>) { await fn(); count++; console.log('PASS  ' + name); }
  const profile = { name: 'Evergreen International School', address: '12 School Road, Lagos', phone: '+234 800 123 4567', email: 'office@example.test', website: 'https://example.test', principalName: 'Dr. Ada Okafor' };
  async function fixture() {
    const [school] = await db.insert(schema.schools).values({ name: 'Settings school', code: 'SET-' + randomUUID(), settings: structuredClone(defaultConfig) }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const users = await db.insert(schema.users).values((['principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent'] as const).map(role => ({
      schoolId, role, loginId: role, passwordHash: 'unused', mustChangePassword: false }))).returning();
    const actors: Record<string, Actor> = {};
    for (const user of users) {
      const [staff] = ['principal', 'vice_principal', 'exam_officer', 'teacher'].includes(user.role) ? await db.insert(schema.staff).values({
        schoolId, userId: user.id, role: user.role, staffNumber: user.role, firstName: 'Ada', lastName: user.role }).returning() : [];
      actors[user.role] = { schoolId, userId: user.id, role: user.role, loginId: user.loginId, staffId: staff?.id ?? null, studentId: null };
    }
    const session = await service.createSession(actors.principal!, { title: '2026/2027', startsOn: '2026-09-01', endsOn: '2027-07-31', makeCurrent: true });
    const terms = await db.select().from(schema.terms).where(eq(schema.terms.sessionId, session.id)).orderBy(asc(schema.terms.position));
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1' }).returning();
    const [classroom] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, arm: 'A', displayName: 'JSS1 A' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: actors.teacher!.staffId!, classId: classroom!.id, assignmentType: 'class_teacher' });
    const [student] = await db.insert(schema.students).values({ schoolId, admissionNumber: '001', firstName: 'Amara', lastName: 'Okafor' }).returning();
    await db.insert(schema.enrollments).values({ schoolId, studentId: student!.id, sessionId: session.id, classId: classroom!.id });
    const [subject] = await db.insert(schema.subjects).values({ schoolId, code: 'MATH', name: 'Mathematics' }).returning();
    await db.insert(schema.studentSubjects).values({ schoolId, studentId: student!.id, sessionId: session.id, subjectId: subject!.id });
    return { schoolId, actors, session, terms, classroom: classroom!, student: student!, subject: subject!, scope: { classId: classroom!.id, sessionId: session.id, termId: terms[0]!.id } };
  }
  try {
    const a = await fixture(), b = await fixture(), principal = a.actors.principal!;
    const school = async () => (await db.select().from(schema.schools).where(eq(schema.schools.id, a.schoolId)))[0]!;
    await check('new session has exactly three terms and coherent current flags', async () => { const v = await service.settingsView(principal); assert.equal(v.terms.length, 3); assert.equal(v.terms.filter(t => t.isCurrent).length, 1); assert.equal(v.sessions.filter(s => s.isCurrent).length, 1); });
    for (const role of ['vice_principal', 'exam_officer', 'teacher', 'student', 'parent']) {
      await check(role + ' cannot change school profile', () => assert.rejects(service.saveProfile(a.actors[role]!, profile)));
      await check(role + ' cannot change academic policy', () => assert.rejects(service.saveAcademic(a.actors[role]!, structuredClone(defaultConfig))));
    }
    await check('forged identity cannot mutate settings', () => assert.rejects(service.saveProfile({ ...principal, userId: b.actors.principal!.userId }, profile)));
    await check('VP may inspect settings without write capability', async () => assert.equal((await service.settingsView(a.actors.vice_principal!)).school.id, a.schoolId));
    await check('student cannot access settings', () => assert.rejects(service.settingsView(a.actors.student!)));
    await check('foreign session/term denied', () => assert.rejects(service.selectPeriod(principal, { sessionId: b.session.id, termId: b.terms[0]!.id })));
    await check('mismatched session/term denied', () => assert.rejects(service.selectPeriod(principal, { sessionId: a.session.id, termId: b.terms[0]!.id })));
    await check('duplicate session rejected', () => assert.rejects(service.createSession(principal, { title: a.session.title, startsOn: '', endsOn: '', makeCurrent: false })));
    await check('term current selection changes coherently', async () => { await service.selectPeriod(principal, { sessionId: a.session.id, termId: a.terms[1]!.id }); const v = await service.settingsView(principal); assert.deepEqual(v.terms.filter(t => t.isCurrent).map(t => t.id), [a.terms[1]!.id]); });
    await service.selectPeriod(principal, { sessionId: a.session.id, termId: a.terms[0]!.id });
    await check('term dates outside session rejected', () => assert.rejects(service.saveTerm(principal, { sessionId: a.session.id, termId: a.terms[0]!.id, title: 'First Term', position: 1, startsOn: '2025-01-01', endsOn: '' })));
    await check('term dates can be saved without changing identity', () => service.saveTerm(principal, { sessionId: a.session.id, termId: a.terms[0]!.id, title: 'First Term', position: 1, startsOn: '2026-09-08', endsOn: '2026-12-18' }));
    await check('duplicate term position rejected', () => assert.rejects(service.saveTerm(principal, { sessionId: a.session.id, title: 'Duplicate', position: 1, startsOn: '', endsOn: '' })));
    const png = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#195337' } }).png().toBuffer();
    const crest = await normalizeImage(new File([new Uint8Array(png)], 'crest.png', { type: 'image/png' }));
    await check('raster normalization produces bounded PNG', () => { assert(crest.startsWith('data:image/png;base64,')); assert(crest.length < 400000); });
    await check('SVG signature content rejected despite image mime', () => assert.rejects(normalizeImage(new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], 'fake.png', { type: 'image/png' }))));
    await check('corrupt upload rejected', () => assert.rejects(normalizeImage(new File(['not an image'], 'crest.jpg', { type: 'image/jpeg' }))));
    await check('profile branding persists without changing code', async () => { const code = (await school()).code; await service.saveProfile(principal, profile, crest); const saved = await school(); assert.equal(saved.name, profile.name); assert.equal(saved.logoUrl, crest); assert.equal(saved.code, code); });
    const changed = structuredClone(defaultConfig); changed.gradingScale.name = 'Evergreen scale'; changed.gradingScale.bands[0]!.min = 80;
    await check('grade edit creates immutable school version and retains old scale', async () => { await service.saveAcademic(principal, changed); const versions = await db.select().from(schema.gradingScaleVersions).where(eq(schema.gradingScaleVersions.schoolId, a.schoolId)); assert.equal(versions.length, 2); assert.equal((await school()).settings.gradingScale && (await service.settingsView(principal)).school.settings.gradingScale !== null, true); });
    await check('client cannot spoof grading version', async () => { changed.gradingScale.version = 900; await service.saveAcademic(principal, changed); const cfg = (await school()).settings.gradingScale as { version: number }; assert.equal(cfg.version, 1); });
    await check('RLS isolates historical grading snapshots', async () => { const foreign = await forSchool(a.schoolId, tx => tx.select().from(schema.gradingScaleVersions).where(eq(schema.gradingScaleVersions.schoolId, b.schoolId))); assert.deepEqual(foreign, []); });
    await check('app role cannot rewrite immutable scale snapshots', async () => { const updated = await forSchool(a.schoolId, tx => tx.update(schema.gradingScaleVersions).set({ version: 99 }).returning()); assert.deepEqual(updated, []); });
    await db.insert(schema.assessmentScores).values({ schoolId: a.schoolId, studentId: a.student.id, subjectId: a.subject.id, sessionId: a.session.id, termId: a.terms[0]!.id, componentKey: 'ca1', score: '0', maxScore: '40', enteredBy: principal.userId });
    await check('in-use assessment maxima cannot change', async () => { const c = structuredClone(changed); c.assessmentComponents[0]!.maxScore = 30; c.assessmentComponents[1]!.maxScore = 70; await assert.rejects(service.saveAcademic(principal, c), /in use/); });
    await check('in-use labels may change safely', async () => { changed.assessmentComponents[0]!.label = 'Class assessment'; await service.saveAcademic(principal, changed); });
    await check('principal saves own typed signature', () => service.saveSignature(principal, { role: 'principal', name: 'Dr. Ada Okafor', type: 'text', text: 'Ada Okafor' }));
    await check('teacher cannot impersonate principal signature', () => assert.rejects(service.saveSignature(a.actors.teacher!, { role: 'principal', name: 'Forged', type: 'text', text: 'Forged' })));
    await check('forged staff id cannot sign', () => assert.rejects(service.saveSignature({ ...principal, staffId: b.actors.principal!.staffId }, { role: 'principal', name: 'Forged', type: 'text', text: 'Forged' })));
    await check('assigned teacher saves own uploaded signature', () => service.saveSignature(a.actors.teacher!, { role: 'class_teacher', name: 'Class Teacher', type: 'upload', text: '' }, crest));
    await check('unassigned EO cannot create teacher signature', () => assert.rejects(service.saveSignature(a.actors.exam_officer!, { role: 'class_teacher', name: 'Officer', type: 'text', text: 'Officer' })));
    await check('principal remark ranges saved', () => service.saveRanges(principal, 'principal', [{ min: 0, remark: 'Keep working steadily.' }, { min: 70, remark: 'Excellent progress.' }]));
    await check('teacher ranges remain staff scoped', () => service.saveRanges(a.actors.teacher!, 'class_teacher', [{ min: 0, remark: 'Keep practising.' }]));
    await check('teacher cannot change principal remark ranges', () => assert.rejects(service.saveRanges(a.actors.teacher!, 'principal', [])));
    await db.insert(schema.subjectResults).values({ schoolId: a.schoolId, studentId: a.student.id, subjectId: a.subject.id, sessionId: a.session.id, termId: a.terms[0]!.id, complete: true, total: '0', state: 'compiled', gradingScaleId: 'school-' + a.schoolId, gradingScaleVersion: 1 });
    const remarkScope = { studentId: a.student.id, sessionId: a.session.id, termId: a.terms[0]!.id, role: 'principal', remark: 'A personal observation.' };
    await check('automatic zero-average remark is snapshotted', async () => { await forSchool(a.schoolId, tx => snapshotRemarks(tx, principal, a.scope, [a.student.id])); const extras = await forSchool(a.schoolId, tx => reportExtras(tx, a.student.id, a.session.id, a.terms[0]!.id, a.classroom.id)); assert.equal(extras.remarks.principal, 'Keep working steadily.'); assert(extras.signatures.principal); assert(extras.signatures.class_teacher); });
    await check('manual remark survives compilation snapshot', async () => { await saveManualRemark(principal, remarkScope); await forSchool(a.schoolId, tx => snapshotRemarks(tx, principal, a.scope, [a.student.id])); const extras = await forSchool(a.schoolId, tx => reportExtras(tx, a.student.id, a.session.id, a.terms[0]!.id, a.classroom.id)); assert.equal(extras.remarks.principal, remarkScope.remark); });
    await check('class teacher can override own student remark before review', () => saveManualRemark(a.actors.teacher!, { ...remarkScope, role: 'class_teacher', remark: 'Contributes thoughtfully in class.' }));
    await check('foreign student manual remark denied', () => assert.rejects(saveManualRemark(a.actors.teacher!, { ...remarkScope, studentId: b.student.id, role: 'class_teacher' })));
    for (const state of ['reviewed', 'published', 'locked'] as const) {
      await db.update(schema.subjectResults).set({ state }).where(eq(schema.subjectResults.schoolId, a.schoolId));
      await check(state + ' report blocks remark changes', () => assert.rejects(saveManualRemark(principal, remarkScope)));
    }
    await check('term referenced by results cannot be renamed', () => assert.rejects(service.saveTerm(principal, { sessionId: a.session.id, termId: a.terms[0]!.id, title: 'Changed', position: 1, startsOn: '', endsOn: '' })));
    await check('exam default stored using supported duration', async () => { await service.saveExamDefaults(principal, { durationMinutes: 90 }); assert.deepEqual((await school()).settings.examDefaults, { durationMinutes: 90 }); });
    await check('audit records contain meaningful before and after values', async () => { const logs = await db.select().from(schema.auditLog).where(eq(schema.auditLog.schoolId, a.schoolId)); assert(logs.some(l => l.action === 'settings.profile' && l.before && l.after)); assert(logs.some(l => l.action === 'settings.academic' && l.before && l.after)); assert(logs.some(l => l.action === 'settings.manual_remark' && l.before && l.after)); });
    await check('suspended principal denied', async () => { await db.update(schema.users).set({ status: 'suspended' }).where(eq(schema.users.id, principal.userId)); await assert.rejects(service.saveProfile(principal, profile)); await db.update(schema.users).set({ status: 'active' }).where(eq(schema.users.id, principal.userId)); });
    if (process.env.CA_TEST_HTTP_URL) {
      const base = new URL(process.env.CA_TEST_HTTP_URL); assert(['localhost', '127.0.0.1'].includes(base.hostname));
      const token = randomUUID() + randomUUID();
      await db.insert(schema.sessions).values({ id: createHash('sha256').update(token).digest('hex'), userId: principal.userId, expiresAt: new Date(Date.now() + 600000) });
      const headers = { cookie: 'educbt.session=' + token };
      await check('Node 20 settings route responds', async () => { const r = await fetch(new URL('/portal/settings', base), { headers }); assert.equal(r.status, 200); assert((await r.text()).includes('School Settings')); });
      await check('report renders saved signatures and remarks', async () => { const r = await fetch(new URL('/portal/reports/' + a.student.id + '?term=' + a.terms[0]!.id, base), { headers }); assert.equal(r.status, 200); const html = await r.text(); assert(html.includes('A personal observation.')); assert(html.includes('Ada Okafor')); assert(html.includes('Evergreen scale')); });
      const browserModule = process.env.SETTINGS_BROWSER_MODULE;
      assert(browserModule, 'Settings HTTP checks require browser QA runtime; do not silently skip');
      const { chromium } = await import(browserModule);
      const browser = await chromium.launch({ headless: true, ...(process.env.SETTINGS_BROWSER_EXECUTABLE ? { executablePath: process.env.SETTINGS_BROWSER_EXECUTABLE } : {}) });
      try {
        await mkdir('baseline-logs', { recursive: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
        await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
        const page = await context.newPage();
        const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
        await page.goto(new URL('/portal/settings', base).href, { waitUntil: 'networkidle' });
        await check('desktop settings and sidebar render without overflow', async () => { await page.getByRole('heading', { name: 'School Settings', exact: true }).waitFor(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: 'baseline-logs/settings-desktop.png', fullPage: true }); });
        await check('profile save through browser succeeds', async () => { await page.getByLabel('Phone', { exact: true }).fill('+234 800 222 3333'); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Changes saved.' }).waitFor(); assert.equal((await school()).phone, '+234 800 222 3333'); });
        await page.getByRole('button', { name: 'Session & term', exact: true }).click();
        await check('duplicate session error is visible and form remains usable', async () => { await page.getByLabel('Session title', { exact: true }).fill('2026/2027'); await page.getByRole('button', { name: 'Create session', exact: true }).click(); await page.getByRole('alert').filter({ hasText: 'That session already exists.' }).waitFor(); await page.screenshot({ path: 'baseline-logs/settings-validation.png', fullPage: true }); });
        await page.getByRole('button', { name: 'Assessments & grading', exact: true }).click();
        await check('in-use assessment controls are disabled but labels remain editable', async () => { assert(await page.getByLabel('Component maximum 1', { exact: true }).isDisabled()); assert(await page.getByLabel('Component name 1', { exact: true }).isEnabled()); await page.screenshot({ path: 'baseline-logs/settings-academic-desktop.png', fullPage: true }); });
        await page.setViewportSize({ width: 390, height: 844 });
        await check('mobile academic tables scroll within cards', async () => { assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: 'baseline-logs/settings-academic-mobile.png', fullPage: true }); });
        await page.getByRole('button', { name: 'School profile', exact: true }).click();
        await check('mobile profile and burger navigation usable', async () => { await page.screenshot({ path: 'baseline-logs/settings-mobile.png', fullPage: true }); await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('dialog').waitFor(); await page.screenshot({ path: 'baseline-logs/settings-mobile-menu.png', fullPage: true }); await page.getByRole('button', { name: 'Close menu ×' }).click(); });
        await page.getByRole('button', { name: 'Signatures & remarks', exact: true }).click();
        await check('personal signature and range editors render on mobile', async () => { await page.getByRole('heading', { name: 'Your signatures & automatic remarks' }).waitFor(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: 'baseline-logs/settings-signatures-mobile.png', fullPage: true }); });
        await check('browser has no client runtime errors', () => assert.deepEqual(errors, []));
      } finally { await browser.close(); }
    }
    console.log(`${count} school settings checks passed`);
  } finally {
    if (schoolIds.length) {
      for (const table of [schema.reportRemarks, schema.staffRemarkRanges, schema.staffSignatures, schema.gradingScaleVersions, schema.subjectResults, schema.assessmentScores, schema.auditLog]) await db.delete(table).where(inArray(table.schoolId, schoolIds));
      const users = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.schoolId, schoolIds));
      if (users.length) await db.delete(schema.sessions).where(inArray(schema.sessions.userId, users.map(u => u.id)));
      await db.delete(schema.schools).where(inArray(schema.schools.id, schoolIds));
    }
    await owner.end(); await client.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
