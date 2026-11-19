/**
 * Calendar and class timetable driven in a real browser against a real production build.
 * Needs `npx next start -p 3100` and Playwright. Disposable LOCAL database only; run by hand.
 *   CAL_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs CAL_BASE_URL=http://127.0.0.1:3100 \
 *   npx tsx src/db/test-calendar-browser.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  const base = new URL(process.env.CAL_BASE_URL ?? 'http://127.0.0.1:3100');
  const { chromium } = await import(process.env.CAL_BROWSER_MODULE ?? 'playwright');
  const { schema } = await import('@/db');
  const { createSession } = await import('@/lib/auth/session-store');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0; const ok = (name: string) => { count++; console.log('PASS  ' + name); };

  const code = 'CB' + randomUUID().slice(0, 6).toUpperCase();
  const [school] = await db.insert(schema.schools).values({ name: 'Browser Cal School', code, settings: {} }).returning(); const schoolId = school!.id;
  const today = new Date(); const iso = (d: Date) => d.toISOString().slice(0, 10);
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true, startsOn: new Date(Date.now() - 60 * 864e5), endsOn: new Date(Date.now() + 200 * 864e5) }).returning();
  await db.insert(schema.terms).values({ schoolId, sessionId: session!.id, title: 'First Term', position: 1, startsOn: new Date(Date.now() - 30 * 864e5), endsOn: new Date(Date.now() + 60 * 864e5), isCurrent: true });
  const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
  const [gold, green] = (await db.insert(schema.classes).values([{ schoolId, levelId: level!.id, displayName: 'JSS1 Gold', arm: 'Gold' }, { schoolId, levelId: level!.id, displayName: 'JSS1 Green', arm: 'Green' }]).returning()) as unknown as [{ id: number }, { id: number }];
  const user = async (role: 'principal' | 'teacher', t: string) => (await db.insert(schema.users).values({ schoolId, role, loginId: `${role}${t}-${code}`, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning())[0]!;
  const principal = await user('principal', ''), tGold = await user('teacher', 'G'), tMath = await user('teacher', 'M');
  const mk = async (u: { id: number }, t: string) => (await db.insert(schema.staff).values({ schoolId, userId: u.id, staffNumber: `${code}/${t}`, firstName: 'Tee', lastName: t, email: `${t.toLowerCase()}.${code.toLowerCase()}@example.com`, role: 'teacher', status: 'active' }).returning())[0]!;
  const sGold = await mk(tGold, 'Gold'), sMath = await mk(tMath, 'Maths');
  const [mth] = await db.insert(schema.subjects).values({ schoolId, code: 'MTH', name: 'Mathematics' }).returning();
  await db.insert(schema.staffAssignments).values([{ schoolId, staffId: sGold.id, classId: gold.id, assignmentType: 'class_teacher', status: 'active' }, { schoolId, staffId: sMath.id, classId: gold.id, subjectId: mth!.id, assignmentType: 'subject_teacher', status: 'active' }, { schoolId, staffId: sMath.id, classId: green.id, subjectId: mth!.id, assignmentType: 'subject_teacher', status: 'active' }]);
  await db.insert(schema.timetablePeriods).values([{ schoolId, name: 'Period 1', position: 1, startTime: '08:00', endTime: '08:40' }, { schoolId, name: 'Break', position: 2, startTime: '08:40', endTime: '09:00', isBreak: true }, { schoolId, name: 'Period 2', position: 3, startTime: '09:00', endTime: '09:40' }]);

  const browser = await chromium.launch();
  const open = async (userId: number, tag: string) => { const { token } = await createSession(userId, '127.0.0.1', tag); const ctx = await browser.newContext({ baseURL: base.origin }); await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]); return ctx.newPage(); };
  try {
    console.log('── the class teacher, in the browser ──');
    const t = await open(tGold.id, 'cal-e2e-teacher');
    await t.goto('/portal/calendar/timetable'); await t.waitForSelector('table.tt-grid');
    assert.match(await t.textContent('h1') ?? '', /Class timetable/); ok('the class teacher opens the class timetable');
    const options = await t.$$eval('select[name=classId] option', (o: Element[]) => o.map((x) => x.textContent ?? ''));
    assert.ok(options.some((o: string) => o.includes('JSS1 Gold') && !o.includes('view only'))); ok('their own class is editable in the picker');
    await t.click('a.tt-link:has-text("Add")'); await t.waitForSelector('form.tt-form');
    await t.selectOption('select[name=subjectId]', { label: 'Mathematics' }); await t.fill('input[name=room]', 'Room 7');
    await t.click('button:has-text("Save lesson")'); await t.waitForSelector('.ok');
    assert.match(await t.textContent('.ok') ?? '', /Lesson saved/); assert.match(await t.textContent('table.tt-grid') ?? '', /Mathematics/); assert.match(await t.textContent('table.tt-grid') ?? '', /Room 7/); ok('adds a lesson and sees it in the grid');
    assert.match(await t.textContent('table.tt-grid') ?? '', /Break/); ok('the break row is shown as a break, with no Add link');
    assert.equal(await t.$$eval('tr.tt-break a.tt-link', (a: Element[]) => a.length), 0);
    await t.reload(); assert.match(await t.textContent('table.tt-grid') ?? '', /Mathematics/); ok('the lesson survives a reload');
    await t.goto(`/portal/calendar/timetable?classId=${green.id}`); await t.waitForSelector('table.tt-grid, .empty-state, .sa-card');
    const shown = await t.textContent('.cal-row h2'); const picker = await t.$$eval('select[name=classId] option', (o: Element[]) => o.map((x) => x.textContent ?? ''));
    assert.equal(shown, 'JSS1 Gold', 'asking for Green must not show Green'); assert.ok(!picker.some((o: string) => o.includes('Green')), 'Green is not even listed for this teacher');
    ok('asking for a class they do not teach shows their own class instead, and never lists the other');
    assert.equal(await t.$$eval('details summary:has-text("School periods")', (a: Element[]) => a.length), 0); ok('a class teacher cannot see the school-wide period editor');
    await t.goto('/portal/calendar'); await t.waitForSelector('.cal-stats');
    assert.equal(await t.$$eval('a:has-text("Add event")', (a: Element[]) => a.length), 0); ok('a class teacher has no Add event button on the academic calendar');
    await t.goto('/portal/calendar/timetable'); await t.click('button:has-text("Publish to students and parents")'); await t.waitForSelector('.ok'); assert.match(await t.textContent('.cal-badge') ?? '', /Published/); ok('publishing shows the Published badge');

    console.log('── the principal, in the browser ──');
    const p = await open(principal.id, 'cal-e2e-principal');
    await p.goto('/portal/calendar'); await p.waitForSelector('.cal-stats');
    assert.match(await p.textContent('.cal-stats') ?? '', /Week \d+/); ok('shows the teaching week');
    assert.ok((await p.$$('.cal-grid .cal-cell')).length >= 28); ok('draws a month grid');
    await p.click('a:has-text("Add event")'); await p.waitForSelector('form.tt-form');
    await p.fill('input[name=title]', 'Founders Day'); await p.selectOption('select[name=category]', 'ceremonial'); await p.fill('input[name=startsOn]', iso(new Date(today.getTime() + 2 * 864e5)));
    await p.click('button:has-text("Save event")'); await p.waitForSelector('.ok'); assert.match(await p.textContent('.ok') ?? '', /Event saved/); ok('adds an event');
    await p.goto('/portal/calendar?view=list'); await p.waitForSelector('.cal-list'); assert.match(await p.textContent('.cal-list') ?? '', /Founders Day/); ok('the event is in the list view');
    await p.goto('/portal/calendar/timetable'); await p.waitForSelector('details summary'); assert.match(await p.textContent('details summary') ?? '', /School periods and breaks/); ok('the principal can edit the school periods');
    await p.goto(`/portal/calendar/timetable?classId=${green.id}`); await p.waitForSelector('a.tt-link:has-text("Add")'); ok('the principal can edit any class');
    await p.goto('/portal/calendar'); await p.click('button:has-text("Publish calendar")'); await p.waitForSelector('.ok'); assert.match(await p.textContent('.ok') ?? '', /published/i); ok('publishes the calendar');

    console.log('── what the teacher now sees ──');
    await t.goto('/portal/calendar?view=list'); await t.waitForSelector('.cal-list'); assert.match(await t.textContent('.cal-list') ?? '', /Founders Day/); ok('after publishing, the teacher sees the school event');
    assert.equal(await t.$$eval('.tt-actions', (a: Element[]) => a.length), 0); ok('and has no edit, cancel or delete controls on it');
    console.log(`\nCALENDAR BROWSER OK: ${count} checks passed.`);
  } finally { await browser.close(); await owner.end(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
