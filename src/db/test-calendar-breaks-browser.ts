/**
 * The calendar's school-day shading, mid-term breaks and term-date editor, driven in a real browser against a real
 * production build. Disposable LOCAL database only:
 *   CA_TEST_HTTP_URL=http://127.0.0.1:3017 QUESTION_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs \
 *   npx tsx src/db/test-calendar-breaks-browser.ts
 * Dates are FIXED (never "today") so the weekdays the checks rely on never drift: 2026 term runs Mon 7 Sep to Fri 18 Dec.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  const base = new URL(process.env.CA_TEST_HTTP_URL ?? 'http://127.0.0.1:3017');
  const { chromium } = await import(process.env.QUESTION_BROWSER_MODULE ?? 'playwright');
  const { schema } = await import('@/db');
  const { createSession } = await import('@/lib/auth/session-store');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0; const ok = (name: string) => { count++; console.log('PASS  ' + name); };
  const failures: string[] = [];
  // Each section runs on its own so one failure is reported without hiding the others.
  const section = async (title: string, fn: () => Promise<void>) => {
    console.log(`── ${title} ──`);
    try { await fn(); } catch (e) { failures.push(`${title}: ${e instanceof Error ? e.message.split('\n')[0] : e}`); console.log('FAIL  ' + failures[failures.length - 1]); }
  };

  const code = 'CK' + randomUUID().slice(0, 6).toUpperCase();
  const [school] = await db.insert(schema.schools).values({ name: 'Break Browser School', code, settings: {} }).returning(); const schoolId = school!.id;
  const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true, startsOn: new Date('2026-09-01T00:00:00Z'), endsOn: new Date('2027-07-31T00:00:00Z') }).returning();
  const sessionId = session!.id;
  const [t1, t2] = await db.insert(schema.terms).values([
    { schoolId, sessionId, title: 'First Term', position: 1, startsOn: new Date('2026-09-07T00:00:00Z'), endsOn: new Date('2026-12-18T00:00:00Z'), isCurrent: true },
    { schoolId, sessionId, title: 'Second Term', position: 2, startsOn: new Date('2027-01-11T00:00:00Z'), endsOn: new Date('2027-04-02T00:00:00Z') },
  ]).returning();
  const user = async (role: 'principal' | 'teacher') => (await db.insert(schema.users).values({ schoolId, role, loginId: `${role}-${code}`, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning())[0]!;
  const principal = await user('principal'), teacher = await user('teacher');
  await db.insert(schema.staff).values({ schoolId, userId: teacher.id, staffNumber: `${code}/T`, firstName: 'T', lastName: 'T', email: `t.${code.toLowerCase()}@x.test`, role: 'teacher', status: 'active' } as never);

  const browser = await chromium.launch();
  const open = async (userId: number, tag: string, viewport = { width: 1280, height: 900 }) => {
    const { token } = await createSession(userId, '127.0.0.1', tag);
    const ctx = await browser.newContext({ baseURL: base.origin, viewport });
    await ctx.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]);
    return ctx.newPage();
  };
  const cell = (d: string) => `[role=gridcell][data-day="${d}"]`;
  // Read the attribute off the element handle: it answers at once, and a missing cell is a clear failure rather than a 30s wait.
  const stateOf = async (pg: { $: (s: string) => Promise<{ getAttribute: (a: string) => Promise<string | null> } | null> }, d: string) => {
    const el = await pg.$(cell(d)); if (!el) throw new Error(`No calendar cell for ${d}`); return el.getAttribute('data-state');
  };
  const settle = async (check: () => Promise<boolean>, what: string) => { for (let i = 0; i < 40; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 250)); } throw new Error('Timed out: ' + what); };
  const termDb = async (id: number) => { const [r] = await db.select().from(schema.terms).where(eq(schema.terms.id, id)); return `${r!.startsOn?.toISOString().slice(0, 10)}..${r!.endsOn?.toISOString().slice(0, 10)}`; };

  try {
    const p = await open(principal.id, 'brk-e2e-principal'), t = await open(teacher.id, 'brk-e2e-teacher');
    const form1 = `form.cal-termform[data-term="${t1!.id}"]`, form2 = `form.cal-termform[data-term="${t2!.id}"]`;
    await section('the principal: school days, weekends and nothing', async () => {
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-10`); await p.waitForSelector('.cal-grid');
    assert.equal(await stateOf(p, '2026-10-14'), 'school_day'); assert.match(await p.textContent(cell('2026-10-14')) ?? '', /School day/); ok('a Wednesday inside the term says "School day"');
    assert.equal(await stateOf(p, '2026-10-17'), 'weekend'); assert.match(await p.textContent(cell('2026-10-17')) ?? '', /Weekend/); ok('a Saturday inside the term says "Weekend"');
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-08`); await p.waitForSelector('.cal-grid');
    assert.equal(await stateOf(p, '2026-08-12'), 'none'); assert.doesNotMatch(await p.textContent(cell('2026-08-12')) ?? '', /School day|Weekend/); ok('a date outside every term has no status label at all');
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-09`); await p.waitForSelector('.cal-grid');
    assert.equal(await stateOf(p, '2026-09-04'), 'none'); assert.equal(await stateOf(p, '2026-09-07'), 'school_day'); ok('the day before the term is "none", the first day is a school day');

    });
    await section('adding a mid-term break', async () => {
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-10&edit=new`); await p.waitForSelector('form.tt-form');
    const cats = await p.$$eval('form.tt-form select[name=category] option', (o: Element[]) => o.map((x) => x.textContent ?? ''));
    assert.ok(cats.includes('Mid-term break') && cats.includes('Non-instructional day'), cats.join(',')); ok('the event form offers "Mid-term break" and "Non-instructional day"');
    await p.fill('form.tt-form input[name=title]', 'Mid-term break'); await p.selectOption('form.tt-form select[name=category]', 'mid_term_break');
    await p.fill('form.tt-form input[name=startsOn]', '2026-10-26'); await p.fill('form.tt-form input[name=endsOn]', '2026-10-30');
    await p.click('button:has-text("Save event")'); await p.waitForSelector('.ok');
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-10`); await p.waitForSelector('.cal-grid');
    for (const d of ['2026-10-26', '2026-10-28', '2026-10-30']) assert.equal(await stateOf(p, d), 'off', d);
    assert.equal(await stateOf(p, '2026-10-23'), 'school_day');
    assert.match(await p.textContent(cell('2026-10-28')) ?? '', /Mid-term break/); ok('Monday to Friday of the break are "off" and labelled Mid-term break; the days either side stay school days');
    const cls = async (d: string) => (await (await p.$(cell(d)))!.getAttribute('class')) ?? '';
    assert.match(await cls('2026-10-28'), /cal-cell--off/); assert.doesNotMatch(await cls('2026-10-23'), /cal-cell--off/); ok('a day off is shaded (and an ordinary school day is not)');
    assert.equal(await stateOf(p, '2026-10-31'), 'weekend'); ok('the weekend after the break stays a weekend');
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-11`); await p.waitForSelector('.cal-grid');
    assert.equal(await stateOf(p, '2026-11-02'), 'school_day'); ok('the Monday after the break is a school day again');

    });
    await section('restore default', async () => {
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-10&view=list`); await p.waitForSelector('.cal-list');
    assert.equal(await p.$$eval('.tt-actions button:has-text("Restore default")', (b: Element[]) => b.length), 1); ok('the break has a "Restore default" button, not "Cancel"');
    await p.click('.tt-actions button:has-text("Restore default")'); await p.waitForSelector('.ok');
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-10`); await p.waitForSelector('.cal-grid');
    for (const d of ['2026-10-26', '2026-10-28', '2026-10-30']) assert.equal(await stateOf(p, d), 'school_day', d);
    ok('after restoring, every day of the break is an ordinary school day again');

    });
    await section('term dates', async () => {
    await p.goto(`/portal/calendar?session=${sessionId}&terms=1`); await p.waitForSelector('.cal-termform');
    assert.equal(await p.$$eval('form.cal-termform', (f: Element[]) => f.length), 2); ok('the principal sees an editor for each term');
    await p.fill(`${form1} input[name=closesOn]`, '2026-12-11'); await p.click(`${form1} button`); await p.waitForSelector('.ok');
    assert.match(await p.textContent('.ok') ?? '', /Term dates saved/); await settle(async () => (await termDb(t1!.id)) === '2026-09-07..2026-12-11', 'closing date saved');
    ok('changing the closing date saves it to the terms table');
    await p.goto(`/portal/calendar?session=${sessionId}&month=2026-12`); await p.waitForSelector('.cal-grid');
    assert.equal(await stateOf(p, '2026-12-10'), 'school_day'); assert.equal(await stateOf(p, '2026-12-14'), 'none'); ok('the month view follows at once: days after the new closing date have no status');
    const same = await termDb(t1!.id);
    await p.goto(`/portal/calendar?session=${sessionId}&terms=1`); await p.waitForSelector('.cal-termform');
    await p.fill(`${form1} input[name=closesOn]`, '2027-01-20'); await p.click(`${form1} button`); await p.waitForSelector('.alert');
    assert.match(await p.textContent('.alert') ?? '', /overlap Second Term/); assert.equal(await termDb(t1!.id), same); ok('dates that overlap another term are refused with a message, and nothing changes');
    await p.goto(`/portal/calendar?session=${sessionId}&terms=1`); await p.waitForSelector('.cal-termform');
    await p.fill(`${form1} input[name=resumesOn]`, '2026-12-20'); await p.fill(`${form1} input[name=closesOn]`, '2026-12-11'); await p.click(`${form1} button`); await p.waitForSelector('.alert');
    assert.match(await p.textContent('.alert') ?? '', /cannot be before/); assert.equal(await termDb(t1!.id), same); ok('a closing date before the resumption date is refused, and nothing changes');
    await p.goto(`/portal/calendar?session=${sessionId}&terms=1`); await p.waitForSelector('.cal-termform');
    await p.fill(`${form2} input[name=closesOn]`, '2027-09-30'); await p.click(`${form2} button`); await p.waitForSelector('.alert');
    assert.match(await p.textContent('.alert') ?? '', /within the session/); ok('dates outside the session are refused');
    const [log] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, schoolId), eq(schema.auditLog.action, 'calendar.term_dates_changed')));
    assert.ok(log); ok('the change is in the audit log');

    });
    await section('a teacher, and a phone', async () => {
    await t.goto(`/portal/calendar?session=${sessionId}&month=2026-10&terms=1`); await t.waitForSelector('.cal-grid');
    assert.equal(await t.$$eval('form.cal-termform', (f: Element[]) => f.length), 0); assert.equal(await t.$$eval('.cal-termedit', (f: Element[]) => f.length), 0); ok('a teacher sees no term-date editor, even with ?terms=1');
    await db.update(schema.calendarEvents).set({ status: 'cancelled' }).where(eq(schema.calendarEvents.schoolId, schoolId));
    const phone = await open(principal.id, 'brk-e2e-phone', { width: 360, height: 740 });
    await phone.goto(`/portal/calendar?session=${sessionId}&terms=1`); await phone.waitForSelector('.cal-termform');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 2, `page overflows by ${overflow}px on a phone`); ok('on a 360px phone the term editor fits without sideways scrolling');

    });    if (failures.length) { console.log(`\n${failures.length} SECTION(S) FAILED:\n - ` + failures.join('\n - ')); process.exitCode = 1; return; }
    console.log(`\nCALENDAR BREAKS BROWSER OK: ${count} checks passed.`);
  } finally {
    await browser.close();
    await owner`delete from schools where id = ${schoolId}`; await owner.end();
  }
}
main().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; });
