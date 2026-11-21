/**
 * Calendar defaults, breaks and term dates, against the real database. Disposable LOCAL database only:
 *   npx tsx src/db/test-calendar-breaks.ts
 * Covers: the two new categories are stored; term dates edited from the calendar write the same terms table Settings
 * reads (manager only, refused when reversed / overlapping / outside the session, audited); the SCHEDULE of a school is
 * unchanged by an edit that is refused; a mid-term break empties the teacher's "today" and "restore default" (cancel)
 * brings the lessons back; tenant isolation of term dates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

const schoolIds: number[] = [];

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) if (!process.env[key]) throw new Error(`Calendar break tests require ${key}.`);
  const { schema, forSchool, client: appSingleton } = await import('@/db');
  const cal = await import('@/lib/calendar/service');
  const tt = await import('@/lib/calendar/timetable-service');
  const eng = await import('@/lib/calendar/engine');
  const dates = await import('@/lib/calendar/dates');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const rejects = async (name: string, fn: () => unknown | Promise<unknown>, fragment: string) => {
    try { await fn(); } catch (error) {
      if (!(error instanceof Error && error.message.includes(fragment))) throw new Error(`${name}: expected "${fragment}", got "${error instanceof Error ? error.message : error}"`);
      count++; console.log('PASS  ' + name); return;
    }
    throw new Error(`${name}: expected a rejection, got success`);
  };
  const actor = (userId: number, schoolId: number, role: string, staffId: number | null = null): Actor =>
    ({ userId, schoolId, role, loginId: `u${userId}`, staffId, studentId: null, guardianId: null } as unknown as Actor);

  // "Today" in the school's own zone (Lagos by default). The term is built AROUND it so the test works on any day.
  const today = dates.todayIn('Africa/Lagos');
  const weekdayToday = dates.weekday(today) === 0 ? 7 : dates.weekday(today);

  async function fixture(tag: string) {
    const code = 'CB' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: `Brk ${tag}`, code, settings: {} }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true,
      startsOn: new Date(`${dates.addDays(today, -200)}T00:00:00Z`), endsOn: new Date(`${dates.addDays(today, 300)}T00:00:00Z`) }).returning();
    const sessionId = session!.id;
    // First term surrounds today; second term is later; third has no dates yet.
    const termRows = await db.insert(schema.terms).values([
      { schoolId, sessionId, title: 'First Term', position: 1, startsOn: new Date(`${dates.addDays(today, -30)}T00:00:00Z`), endsOn: new Date(`${dates.addDays(today, 60)}T00:00:00Z`), isCurrent: true },
      { schoolId, sessionId, title: 'Second Term', position: 2, startsOn: new Date(`${dates.addDays(today, 120)}T00:00:00Z`), endsOn: new Date(`${dates.addDays(today, 200)}T00:00:00Z`) },
      { schoolId, sessionId, title: 'Third Term', position: 3, startsOn: null, endsOn: null },
    ]).returning();
    const user = async (role: 'principal' | 'exam_officer' | 'teacher', t = '') =>
      (await db.insert(schema.users).values({ schoolId, role, loginId: `${role}${t}-${code}`, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning())[0]!;
    const principal = await user('principal'), examOfficer = await user('exam_officer'), teacher = await user('teacher');
    const [st] = await db.insert(schema.staff).values({ schoolId, userId: teacher.id, staffNumber: `${code}/T`, firstName: 'T', lastName: 'T', email: `t.${code.toLowerCase()}@x.test`, role: 'teacher', status: 'active' } as never).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
    const [cls] = await db.insert(schema.classes).values({ schoolId, levelId: level!.id, displayName: 'JSS1 Gold', arm: 'Gold' }).returning();
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: st!.id, classId: cls!.id, assignmentType: 'class_teacher', status: 'active' } as never);
    const [subject] = await db.insert(schema.subjects).values({ schoolId, name: 'Maths', code: 'MTH' } as never).returning();
    const [period] = await db.insert(schema.timetablePeriods).values({ schoolId, name: 'Period 1', position: 1, startTime: '08:00', endTime: '08:40' }).returning();
    await db.insert(schema.timetableLessons).values({ schoolId, sessionId, classId: cls!.id, periodId: period!.id, weekday: weekdayToday, subjectId: subject!.id, staffId: st!.id });
    await db.insert(schema.timetablePublication).values({ schoolId, sessionId, classId: cls!.id, publishedAt: new Date() } as never).onConflictDoNothing();
    return { schoolId, sessionId, terms: termRows, principal, examOfficer, teacher, staffId: st!.id, classId: cls!.id };
  }

  const F = await fixture('one'), G = await fixture('two');
  const P = actor(F.principal.id, F.schoolId, 'principal'), EO = actor(F.examOfficer.id, F.schoolId, 'exam_officer');
  const T = actor(F.teacher.id, F.schoolId, 'teacher', F.staffId), PB = actor(G.principal.id, G.schoolId, 'principal');
  const [t1, t2, t3] = F.terms;
  const termRow = async (id: number) => (await db.select().from(schema.terms).where(eq(schema.terms.id, id)))[0]!;
  const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const evBase = { startsOn: today, endsOn: today, allDay: true, audience: 'everyone', status: 'scheduled', published: true };

  // ── the two new categories exist and are stored
  await check('a mid-term break and a non-instructional day can be saved', async () => {
    for (const category of ['mid_term_break', 'non_instructional'] as const) {
      const r = await cal.saveEvent(P, F.sessionId, { ...evBase, title: `T ${category}`, category, startsOn: dates.addDays(today, 90), endsOn: dates.addDays(today, 90) });
      assert.ok(r.ok, JSON.stringify(r));
      const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, (r as { id: number }).id));
      assert.equal(row!.category, category);
    }
  });
  await check('a made-up category is still refused', async () => {
    const r = await cal.saveEvent(P, F.sessionId, { ...evBase, title: 'X', category: 'long_weekend' });
    assert.equal(r.ok, false);
  });

  // ── term dates from the calendar
  await check('the principal can change a term\'s dates: the SAME terms row Settings reads is updated, and it is audited', async () => {
    const was = await termRow(t1!.id);
    const startsOn = dates.addDays(today, -20), endsOn = dates.addDays(today, 70);
    await cal.setTermDates(P, F.sessionId, { termId: t1!.id, startsOn, endsOn });
    const now = await termRow(t1!.id);
    assert.equal(ymd(now.startsOn), startsOn); assert.equal(ymd(now.endsOn), endsOn);
    assert.equal(now.title, 'First Term'); assert.equal(now.position, 1); assert.equal(now.isCurrent, true);
    const [log] = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, F.schoolId), eq(schema.auditLog.action, 'calendar.term_dates_changed')));
    assert.ok(log); assert.deepEqual((log!.before as { startsOn: string }).startsOn, ymd(was.startsOn)); assert.equal((log!.after as { endsOn: string }).endsOn, endsOn);
    const view = await cal.loadCalendar(P, F.sessionId);
    assert.equal(view.terms.find((x) => x.id === t1!.id)!.startsOn, startsOn);
  });
  await check('a term with no dates yet can be given dates', async () => {
    await cal.setTermDates(P, F.sessionId, { termId: t3!.id, startsOn: dates.addDays(today, 230), endsOn: dates.addDays(today, 290) });
    assert.equal(ymd((await termRow(t3!.id)).startsOn), dates.addDays(today, 230));
  });
  const keep = async () => JSON.stringify((await db.select().from(schema.terms).where(eq(schema.terms.sessionId, F.sessionId)).orderBy(schema.terms.position)).map((t) => [ymd(t.startsOn), ymd(t.endsOn)]));
  const refused = async (name: string, input: { termId: number; startsOn: string; endsOn: string }, fragment: string, who = P) => {
    const before = await keep();
    await rejects(name, () => cal.setTermDates(who, F.sessionId, input), fragment);
    assert.equal(await keep(), before, `${name}: a refused edit must change nothing`);
  };
  await refused('closing before resuming is refused and nothing changes', { termId: t1!.id, startsOn: dates.addDays(today, 10), endsOn: dates.addDays(today, 5) }, 'cannot be before');
  await refused('overlapping another term is refused and nothing changes', { termId: t1!.id, startsOn: dates.addDays(today, -20), endsOn: dates.addDays(today, 130) }, 'overlap Second Term');
  await refused('dates outside the session are refused and nothing changes', { termId: t2!.id, startsOn: dates.addDays(today, 120), endsOn: dates.addDays(today, 400) }, 'within the session');
  await refused('a term of another session or school cannot be edited through this one', { termId: G.terms[0]!.id, startsOn: dates.addDays(today, 1), endsOn: dates.addDays(today, 2) }, 'not found');
  await refused('only managers may change term dates: a teacher is refused', { termId: t2!.id, startsOn: dates.addDays(today, 121), endsOn: dates.addDays(today, 199) }, '', T);
  await check('the exam officer (a calendar manager) may change term dates', async () => {
    await cal.setTermDates(EO, F.sessionId, { termId: t2!.id, startsOn: dates.addDays(today, 121), endsOn: dates.addDays(today, 199) });
    assert.equal(ymd((await termRow(t2!.id)).startsOn), dates.addDays(today, 121));
  });
  await check('another school\'s principal cannot edit this school\'s term, and this school\'s terms are untouched', async () => {
    const before = await keep();
    await assert.rejects(() => cal.setTermDates(PB, F.sessionId, { termId: t2!.id, startsOn: dates.addDays(today, 130), endsOn: dates.addDays(today, 140) }));
    assert.equal(await keep(), before);
  });

  // ── a break reaches the timetable: "today's lessons"
  const todays = async () => (await tt.loadTimetable(T, F.sessionId, F.classId));
  await check('on an ordinary school day the teacher\'s "today" shows the lesson', async () => {
    const v = await todays();
    if (dates.weekday(today) === 0 || dates.weekday(today) === 6) { assert.equal(v.teachingToday, false); return; }
    assert.equal(v.teachingToday, true); assert.equal(v.todaysLessons.length, 1);
  });
  if (dates.weekday(today) !== 0 && dates.weekday(today) !== 6) {
    for (const category of ['mid_term_break', 'non_instructional', 'public_holiday', 'school_holiday'] as const) {
      await check(`a ${category} covering today empties the teacher's "today", and cancelling it (restore default) brings the lessons back`, async () => {
        const r = await cal.saveEvent(P, F.sessionId, { ...evBase, title: `Off ${category}`, category });
        assert.ok(r.ok, JSON.stringify(r));
        const id = (r as { id: number }).id;
        const off = await todays(); assert.equal(off.teachingToday, false, 'break should switch teaching off'); assert.equal(off.todaysLessons.length, 0);
        await cal.cancelEvent(P, id);
        const back = await todays(); assert.equal(back.teachingToday, true); assert.equal(back.todaysLessons.length, 1);
      });
    }
    await check('an UNPUBLISHED break does not take the day off for staff yet', async () => {
      const r = await cal.saveEvent(P, F.sessionId, { ...evBase, title: 'Draft break', category: 'mid_term_break', published: false });
      assert.ok(r.ok);
      assert.equal((await todays()).teachingToday, true);
      await cal.cancelEvent(P, (r as { id: number }).id);
    });
  }
  // The break checks above need a weekday (a weekend is never a teaching day, so there is nothing for a break to remove).
  // Say so out loud instead of passing silently, and prove the same wiring on any day by reading the timetable's own source.
  await check(`the timetable asks for EVERY non-instructional category (today is ${dates.weekday(today) === 0 || dates.weekday(today) === 6 ? 'a weekend, so the live break checks were skipped' : 'a weekday, so the live break checks ran'})`, async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/lib/calendar/timetable-service.ts', 'utf8');
    assert.ok(src.includes('NON_INSTRUCTIONAL'), 'timetable-service must use the shared NON_INSTRUCTIONAL list');
    assert.ok(!/\[\s*'public_holiday'\s*,\s*'school_holiday'\s*\]/.test(src), 'timetable-service must not keep its own two-category list');
  });
  await check('the engine and the stored data agree: instructional days drop by exactly the break length', async () => {
    const before = eng.instructionalDays((await cal.loadCalendar(P, F.sessionId)).terms, (await cal.loadCalendar(P, F.sessionId)).events).size;
    const start = dates.addDays(today, 5);
    const r = await cal.saveEvent(P, F.sessionId, { ...evBase, title: 'Week off', category: 'mid_term_break', startsOn: start, endsOn: dates.addDays(start, 6) });
    assert.ok(r.ok);
    const v = await cal.loadCalendar(P, F.sessionId);
    assert.equal(eng.instructionalDays(v.terms, v.events).size, before - 5, 'seven calendar days off = five school days off');
    await cal.cancelEvent(P, (r as { id: number }).id);
  });

  console.log(`\n${count} checks passed.`);
  for (const id of schoolIds) await owner`delete from schools where id = ${id}`;
  await owner.end(); await appSingleton.end({ timeout: 2 });
}
main().catch(async (e) => {
  console.error('FAILED:', e);
  // A failing run must not leave its disposable schools behind.
  try { const o = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} }); for (const id of schoolIds) await o`delete from schools where id = ${id}`; await o.end(); } catch { /* best effort */ }
  process.exit(1);
});
