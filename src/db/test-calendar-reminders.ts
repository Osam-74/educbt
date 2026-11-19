/**
 * Calendar reminder job. Disposable LOCAL database only:  npx tsx src/db/test-calendar-reminders.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';

async function main() {
  for (const k of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) if (!process.env[k]) throw new Error(`Reminder tests require ${k}.`);
  const { schema, client: appSingleton } = await import('@/db');
  const job = await import('@/lib/jobs/calendar-reminders');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} }); const db = drizzle(owner, { schema });
  let count = 0; const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  async function fixture(tag: string, tz?: string) {
    const code = 'RM' + randomUUID().slice(0, 6).toUpperCase();
    const [sc] = await db.insert(schema.schools).values({ name: `Rem ${tag}`, code, settings: tz ? { timezone: tz } : {} }).returning(); const schoolId = sc!.id;
    const [ses] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true }).returning(); const sessionId = ses!.id;
    const [lv] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
    const [c1, c2] = (await db.insert(schema.classes).values([{ schoolId, levelId: lv!.id, displayName: 'Gold', arm: 'G' }, { schoolId, levelId: lv!.id, displayName: 'Green', arm: 'R' }]).returning()) as unknown as [{ id: number }, { id: number }];
    const user = async (role: 'principal' | 'teacher' | 'student' | 'parent', t: string) => (await db.insert(schema.users).values({ schoolId, role, loginId: `${role}${t}-${code}`, passwordHash: 'x', mustChangePassword: false, status: 'active' }).returning())[0]!;
    const principal = await user('principal', ''), teacher = await user('teacher', 'A');
    const st = (await db.insert(schema.staff).values({ schoolId, userId: teacher.id, staffNumber: `${code}/A`, firstName: 'T', lastName: 'A', email: `a.${code}@e.com`, role: 'teacher', status: 'active' }).returning())[0]!;
    await db.insert(schema.staffAssignments).values({ schoolId, staffId: st.id, classId: c1.id, assignmentType: 'subject_teacher', status: 'active' });
    const stu = async (t: string, classId: number) => { const u = await user('student', t); const s = (await db.insert(schema.students).values({ schoolId, userId: u.id, admissionNumber: `${code}/${t}`, firstName: t, lastName: 'S', status: 'active' }).returning())[0]!; await db.insert(schema.enrollments).values({ schoolId, studentId: s.id, classId, sessionId, status: 'active' }); return { u, s }; };
    const sg = await stu('G', c1.id), sr = await stu('R', c2.id);
    const pu = await user('parent', 'G'); const [g] = await db.insert(schema.guardians).values({ schoolId, userId: pu.id, fullName: 'P', email: pu.loginId, inviteStatus: 'accepted' }).returning(); await db.insert(schema.guardianStudent).values({ schoolId, guardianId: g!.id, studentId: sg.s.id, canViewResults: true });
    await db.insert(schema.academicCalendars).values({ schoolId, sessionId, state: 'published', publishedAt: new Date() });
    return { schoolId, sessionId, c1, c2, principal, teacher, sg, sr, pu };
  }
  const day = (d: number) => new Date(Date.UTC(2026, 10, 19 + d)).toISOString().slice(0, 10); // 19 Nov 2026 is "today"
  const NOW = new Date('2026-11-19T10:00:00Z'); // 11:00 in Lagos
  const ev = (F: { schoolId: number; sessionId: number }, o: Record<string, unknown>) => db.insert(schema.calendarEvents).values({ schoolId: F.schoolId, sessionId: F.sessionId, title: 'Event', category: 'school_event', startsOn: day(3), endsOn: day(3), status: 'scheduled', published: true, remindDaysBefore: 3, audience: 'everyone', ...o } as never).returning().then((r) => r[0]!);
  const notes = async (schoolId: number) => db.select().from(schema.notifications).where(and(eq(schema.notifications.schoolId, schoolId), eq(schema.notifications.type, 'calendar_event')));
  const sentAt = async (id: number) => (await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)))[0]!.reminderSentAt;

  const F = await fixture('one');
  console.log('── when a reminder is due ──');
  await check('three days before, an everyone-event reaches every active person, with the right words', async () => {
    const e = await ev(F, { title: 'Founders Day', category: 'ceremonial', venue: 'Hall' });
    const r = await job.sendRemindersForSchool(F.schoolId, NOW); assert.equal(r.events, 1); assert.equal(r.notifications, 5);
    const n = (await notes(F.schoolId))[0]!; assert.equal(n.title, 'Founders Day is in 3 days'); assert.ok(n.body.includes('Ceremony') && n.body.includes('Hall') && n.body.includes(day(3))); assert.equal(n.link, '/portal/calendar'); assert.ok(await sentAt(e.id));
  });
  await check('it is sent ONCE: running the job again, or ten times, sends nothing more', async () => {
    const before = (await notes(F.schoolId)).length; for (let i = 0; i < 10; i++) await job.sendRemindersForSchool(F.schoolId, new Date(NOW.getTime() + i * 3600e3)); assert.equal((await notes(F.schoolId)).length, before);
  });
  await check('two runs at the same instant still send once', async () => {
    const e = await ev(F, { title: 'Race', startsOn: day(2), endsOn: day(2), remindDaysBefore: 5 });
    const before = (await notes(F.schoolId)).length; await Promise.all([job.sendRemindersForSchool(F.schoolId, NOW), job.sendRemindersForSchool(F.schoolId, NOW)]);
    assert.equal((await notes(F.schoolId)).length - before, 5, 'exactly one batch'); assert.ok(await sentAt(e.id));
  });
  await check('too early is left alone: an event 10 days away with a 3-day reminder waits', async () => {
    const e = await ev(F, { title: 'Far', startsOn: day(10), endsOn: day(10), remindDaysBefore: 3 }); const b = (await notes(F.schoolId)).length; await job.sendRemindersForSchool(F.schoolId, NOW);
    assert.equal((await notes(F.schoolId)).length, b); assert.equal(await sentAt(e.id), null);
    await job.sendRemindersForSchool(F.schoolId, new Date(NOW.getTime() + 7 * 864e5)); assert.ok(await sentAt(e.id), 'sent once its day arrives');
  });
  await check('a late run still sends while the event is ahead, and wording says tomorrow / today', async () => {
    await ev(F, { title: 'Soon', startsOn: day(1), endsOn: day(1), remindDaysBefore: 7 }); await ev(F, { title: 'Now', startsOn: day(0), endsOn: day(0), remindDaysBefore: 1 });
    await job.sendRemindersForSchool(F.schoolId, NOW); const t = (await notes(F.schoolId)).map((n) => n.title); assert.ok(t.includes('Soon is tomorrow') && t.includes('Now is today'));
  });

  console.log('── when it must NOT send ──');
  await check('a draft, a cancelled, a completed, an unpublished event and "no reminder" (0) are all skipped', async () => {
    const skipped = [await ev(F, { title: 'a', status: 'draft' }), await ev(F, { title: 'b', status: 'cancelled' }), await ev(F, { title: 'c', status: 'completed' }), await ev(F, { title: 'd', published: false }), await ev(F, { title: 'e', remindDaysBefore: 0 })];
    const b = (await notes(F.schoolId)).length; await job.sendRemindersForSchool(F.schoolId, NOW); assert.equal((await notes(F.schoolId)).length, b); for (const e of skipped) assert.equal(await sentAt(e.id), null);
  });
  await check('an event that has already started or passed never sends', async () => {
    const past = await ev(F, { title: 'Past', startsOn: day(-2), endsOn: day(-2), remindDaysBefore: 5 }); const b = (await notes(F.schoolId)).length; await job.sendRemindersForSchool(F.schoolId, NOW); assert.equal((await notes(F.schoolId)).length, b); assert.equal(await sentAt(past.id), null);
  });
  await check('nothing goes out while the calendar is a draft, and it goes once published', async () => {
    const G = await fixture('draft'); await db.update(schema.academicCalendars).set({ state: 'draft' }).where(eq(schema.academicCalendars.schoolId, G.schoolId));
    const e = await ev(G, { title: 'Held back' }); await job.sendRemindersForSchool(G.schoolId, NOW); assert.equal((await notes(G.schoolId)).length, 0); assert.equal(await sentAt(e.id), null);
    await db.update(schema.academicCalendars).set({ state: 'published' }).where(eq(schema.academicCalendars.schoolId, G.schoolId)); await job.sendRemindersForSchool(G.schoolId, NOW); assert.equal((await notes(G.schoolId)).length, 5);
  });

  console.log('── who gets it ──');
  await check('staff-only: staff only (not students or parents); teachers-only: teachers; class event: that class\'s students, parents, teachers and leadership, not the other class', async () => {
    const H = await fixture('aud');
    const ids = async (title: string) => (await notes(H.schoolId)).filter((n) => n.title.startsWith(title)).map((n) => Number(n.userId)).sort((a, b) => a - b);
    await ev(H, { title: 'StaffOnly', audience: 'staff' }); await ev(H, { title: 'TeachOnly', audience: 'teachers' }); await ev(H, { title: 'GoldTrip', audience: 'classes' }).then((e) => db.insert(schema.calendarEventClasses).values({ schoolId: H.schoolId, eventId: e.id, classId: H.c1.id }));
    await ev(H, { title: 'Parents', audience: 'guardians' }); await job.sendRemindersForSchool(H.schoolId, NOW);
    assert.deepEqual(await ids('StaffOnly'), [H.principal.id, H.teacher.id].sort((a, b) => a - b)); assert.deepEqual(await ids('TeachOnly'), [H.teacher.id]); assert.deepEqual(await ids('Parents'), [H.pu.id]);
    const gold = await ids('GoldTrip'); assert.ok(gold.includes(H.sg.u.id) && gold.includes(H.pu.id) && gold.includes(H.teacher.id) && gold.includes(H.principal.id)); assert.ok(!gold.includes(H.sr.u.id), 'the Green student is not told about Gold\'s trip');
  });
  await check('a suspended person is not notified', async () => {
    const K = await fixture('susp'); await db.update(schema.users).set({ status: 'suspended' }).where(eq(schema.users.id, K.sg.u.id)); await ev(K, {}); await job.sendRemindersForSchool(K.schoolId, NOW);
    assert.ok(!(await notes(K.schoolId)).some((n) => Number(n.userId) === K.sg.u.id)); assert.equal((await notes(K.schoolId)).length, 4);
  });

  console.log('── timezones and isolation ──');
  await check('the school\'s own day decides: 23:30 UTC is already tomorrow in Lagos, so a 1-day reminder for "day 1" fires there but not in UTC', async () => {
    const late = new Date('2026-11-19T23:30:00Z'); const L = await fixture('lagos', 'Africa/Lagos'), U = await fixture('utc', 'UTC');
    const le = await ev(L, { title: 'Edge', startsOn: day(2), endsOn: day(2), remindDaysBefore: 1 }), ue = await ev(U, { title: 'Edge', startsOn: day(2), endsOn: day(2), remindDaysBefore: 1 });
    await job.sendRemindersForSchool(L.schoolId, late); await job.sendRemindersForSchool(U.schoolId, late);
    assert.ok(await sentAt(le.id), 'Lagos is already on the 20th: the event on the 21st is 1 day away'); assert.equal(await sentAt(ue.id), null, 'UTC is still the 19th: it is 2 days away');
  });
  await check('a suspended school is skipped while the others still get their reminders, with no failures reported', async () => {
    const M = await fixture('ok'); await ev(M, { title: 'Fine' });
    await owner`update schools set status='suspended' where id=${F.schoolId}`; await owner`update schools set status='active' where id=${M.schoolId}`;
    const s = await job.sendAllCalendarReminders(NOW); assert.equal(s.failures.length, 0); assert.ok(s.remindersSent >= 1); assert.ok((await notes(M.schoolId)).length >= 1); await owner`update schools set status='active' where id=${F.schoolId}`;
  });
  await check('one school\'s events never notify another school\'s people', async () => {
    const A = await fixture('iso-a'), B = await fixture('iso-b'); await ev(A, { title: 'Only A' }); await job.sendRemindersForSchool(A.schoolId, NOW);
    assert.equal((await notes(B.schoolId)).length, 0); assert.ok((await notes(A.schoolId)).every((n) => Number(n.schoolId) === A.schoolId));
  });
  await check('moving an event re-arms its reminder; an empty school is fine', async () => {
    const R = await fixture('move'); const { saveEvent } = await import('@/lib/calendar/service'); const P = { userId: R.principal.id, schoolId: R.schoolId, role: 'principal', loginId: 't', staffId: null, studentId: null };
    const r = await saveEvent(P, R.sessionId, { title: 'Movable', category: 'school_event', startsOn: day(3), endsOn: day(3), allDay: true, audience: 'everyone', status: 'scheduled', published: true, remindDaysBefore: 3 }); assert.ok(r.ok); const id = (r as { id: number }).id;
    await job.sendRemindersForSchool(R.schoolId, NOW); assert.ok(await sentAt(id)); const first = (await notes(R.schoolId)).length;
    await saveEvent(P, R.sessionId, { title: 'Movable', category: 'school_event', startsOn: day(6), endsOn: day(6), allDay: true, audience: 'everyone', status: 'scheduled', published: true, remindDaysBefore: 3 }, id); assert.equal(await sentAt(id), null, 'moved, so armed again');
    await job.sendRemindersForSchool(R.schoolId, new Date(NOW.getTime() + 3 * 864e5)); assert.ok((await notes(R.schoolId)).length > first, 'and it reminds again for the new date');
    const empty = await fixture('empty'); assert.deepEqual(await job.sendRemindersForSchool(empty.schoolId, NOW), { events: 0, notifications: 0 });
  });

  console.log(`\nREMINDERS OK: ${count} checks passed.`);
  await appSingleton.end().catch(() => {}); await owner.end();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
