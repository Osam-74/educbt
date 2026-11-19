/**
 * Academic calendar integration checks. Disposable LOCAL database only:
 *   npx tsx src/db/test-calendar.ts
 * Covers: create/edit/cancel/delete with audit rows, server-side validation,
 * database constraints, recurrence through the service, conflict warnings and the
 * recorded override, publish/archive and who sees what, examination sync (a moved
 * paper is already moved on the calendar, and an exam entry cannot be edited as
 * an event), the timezone, and tenant isolation at the service AND RLS layers.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

const schoolIds: number[] = [];

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) if (!process.env[key]) throw new Error(`Calendar tests require ${key}.`);
  const { schema, forSchool, client: appSingleton } = await import('@/db');
  const cal = await import('@/lib/calendar/service');
  const eng = await import('@/lib/calendar/engine');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const rejects = async (name: string, fn: () => unknown | Promise<unknown>, fragment?: string) => {
    try { await fn(); } catch (error) {
      if (fragment && !(error instanceof Error && error.message.includes(fragment))) throw new Error(`${name}: expected "${fragment}", got "${error instanceof Error ? error.message : error}"`);
      count++; console.log('PASS  ' + name); return;
    }
    throw new Error(`${name}: expected a rejection, got success`);
  };
  const actor = (userId: number, schoolId: number, role: string, staffId: number | null = null, studentId: number | null = null): Actor => ({ userId, schoolId, role, loginId: 'test', staffId, studentId });

  async function fixture(tag: string) {
    const code = 'CL' + randomUUID().slice(0, 6).toUpperCase();
    const [school] = await db.insert(schema.schools).values({ name: `Cal ${tag}`, code, settings: {} }).returning();
    const schoolId = school!.id; schoolIds.push(schoolId);
    const [session] = await db.insert(schema.academicSessions).values({ schoolId, title: '2026/27', isCurrent: true, startsOn: new Date('2026-09-01T00:00:00Z'), endsOn: new Date('2027-07-31T00:00:00Z') }).returning();
    const sessionId = session!.id;
    const termRows = await db.insert(schema.terms).values([
      { schoolId, sessionId, title: 'First Term', position: 1, startsOn: new Date('2026-09-14T00:00:00Z'), endsOn: new Date('2026-12-11T00:00:00Z'), isCurrent: true },
      { schoolId, sessionId, title: 'Second Term', position: 2, startsOn: new Date('2027-01-11T00:00:00Z'), endsOn: new Date('2027-04-02T00:00:00Z') },
    ]).returning();
    const [level] = await db.insert(schema.classLevels).values({ schoolId, name: 'JSS1', levelOrder: 1 }).returning();
    const [c1, c2] = (await db.insert(schema.classes).values([{ schoolId, levelId: level!.id, displayName: 'JSS1 Gold', arm: 'Gold' }, { schoolId, levelId: level!.id, displayName: 'JSS1 Green', arm: 'Green' }]).returning()) as unknown as [{ id: number }, { id: number }];
    const user = async (role: 'principal' | 'vice_principal' | 'exam_officer' | 'teacher' | 'student' | 'parent', t = '') => {
      const [u] = await db.insert(schema.users).values({ schoolId, role, loginId: `${role}${t}-${code}`, passwordHash: 'unused', mustChangePassword: false, status: 'active' }).returning(); return u!;
    };
    const principal = await user('principal'), vice = await user('vice_principal'), examOfficer = await user('exam_officer'), teacher = await user('teacher', 'A'), teacherB = await user('teacher', 'B');
    const mkStaff = async (u: { id: number }, t: string) => (await db.insert(schema.staff).values({ schoolId, userId: u.id, staffNumber: `${code}/${t}`, firstName: 'T', lastName: t, email: `${t.toLowerCase()}.${code.toLowerCase()}@example.com`, role: 'teacher', status: 'active' }).returning())[0]!;
    const staffA = await mkStaff(teacher, 'A'), staffB = await mkStaff(teacherB, 'B');
    await db.insert(schema.staffAssignments).values([{ schoolId, staffId: staffA.id, classId: c1.id, assignmentType: 'subject_teacher', status: 'active' }, { schoolId, staffId: staffB.id, classId: c2.id, assignmentType: 'subject_teacher', status: 'active' }]);
    const mkStudent = async (t: string, classId: number) => {
      const u = await user('student', t);
      const [s] = await db.insert(schema.students).values({ schoolId, userId: u.id, admissionNumber: `${code}/${t}`, firstName: t, lastName: 'S', status: 'active' }).returning();
      await db.insert(schema.enrollments).values({ schoolId, studentId: s!.id, classId, sessionId, status: 'active' }); return { user: u, student: s! };
    };
    const stGold = await mkStudent('G', c1.id), stGreen = await mkStudent('R', c2.id);
    const pu = await user('parent', 'G');
    const [g] = await db.insert(schema.guardians).values({ schoolId, userId: pu.id, fullName: 'Parent G', email: pu.loginId, inviteStatus: 'accepted' }).returning();
    await db.insert(schema.guardianStudent).values({ schoolId, guardianId: g!.id, studentId: stGold.student.id, canViewResults: true });
    return { code, schoolId, sessionId, terms: termRows, c1, c2, principal, vice, examOfficer, teacher, teacherB, staffA, staffB, stGold, stGreen, parent: pu };
  }

  const F = await fixture('one'), G = await fixture('two');
  const P = actor(F.principal.id, F.schoolId, 'principal'), V = actor(F.vice.id, F.schoolId, 'vice_principal'), EO = actor(F.examOfficer.id, F.schoolId, 'exam_officer');
  const TA = actor(F.teacher.id, F.schoolId, 'teacher', F.staffA.id), TB = actor(F.teacherB.id, F.schoolId, 'teacher', F.staffB.id);
  const SG = actor(F.stGold.user.id, F.schoolId, 'student', null, F.stGold.student.id), SR = actor(F.stGreen.user.id, F.schoolId, 'student', null, F.stGreen.student.id);
  const PG = actor(F.parent.id, F.schoolId, 'parent');
  const PB = actor(G.principal.id, G.schoolId, 'principal');
  const base = { category: 'school_event', startsOn: '2026-10-05', endsOn: '2026-10-05', allDay: true, audience: 'everyone', status: 'scheduled', published: true };
  const titles = async (a: Actor, sid = F.sessionId) => (await cal.loadCalendar(a, sid)).events.map((e) => e.title).sort();
  const audits = async (action: string) => (await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.schoolId, F.schoolId), eq(schema.auditLog.action, action))));

  console.log('── create, edit, cancel, delete ──');
  let sportsId = 0;
  await check('a manager creates an event, and it is read back exactly', async () => {
    const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'Inter-house sports', venue: 'Main field', description: 'All classes', remindDaysBefore: 3 });
    assert.ok(r.ok); sportsId = (r as { id: number }).id;
    const v = await cal.loadCalendar(P, F.sessionId); const e = v.events.find((x) => x.id === sportsId)!;
    assert.equal(e.title, 'Inter-house sports'); assert.equal(e.venue, 'Main field'); assert.equal(e.startsOn, '2026-10-05'); assert.equal(e.allDay, true);
  });
  await check('creating wrote an audit row naming who did it', async () => {
    const a = await audits('calendar.event_created'); assert.equal(a.length, 1); assert.equal(Number(a[0]!.actorUserId), F.principal.id); assert.equal(Number(a[0]!.entityId), sportsId);
  });
  await check('editing changes the event, keeps one row, and audits before and after', async () => {
    const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'Inter-house sports day', startsOn: '2026-10-06', endsOn: '2026-10-07' }, sportsId); assert.ok(r.ok);
    const v = await cal.loadCalendar(P, F.sessionId); assert.equal(v.events.filter((x) => x.id === sportsId).length, 1);
    const e = v.events.find((x) => x.id === sportsId)!; assert.equal(e.title, 'Inter-house sports day'); assert.equal(e.endsOn, '2026-10-07');
    const a = (await audits('calendar.event_updated'))[0]!; assert.equal((a.before as { title: string }).title, 'Inter-house sports'); assert.equal((a.after as { title: string }).title, 'Inter-house sports day');
  });
  await check('a timed event keeps its times; an all-day event stores none', async () => {
    const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'PTA meeting', startsOn: '2026-10-20', endsOn: '2026-10-20', allDay: false, startTime: '09:30', endTime: '11:00' }); assert.ok(r.ok);
    const e = (await cal.loadCalendar(P, F.sessionId)).events.find((x) => x.title === 'PTA meeting')!; assert.equal(e.startTime, '09:30'); assert.equal(e.endTime, '11:00'); assert.equal(e.allDay, false);
  });
  await check('cancelling keeps the event, marks it cancelled and audits it', async () => {
    await cal.cancelEvent(P, sportsId); const e = (await cal.loadCalendar(P, F.sessionId)).events.find((x) => x.id === sportsId)!; assert.equal(e.status, 'cancelled'); assert.equal((await audits('calendar.event_cancelled')).length, 1);
  });
  await check('deleting removes it, with the old details kept in the audit row', async () => {
    const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'Made by mistake', startsOn: '2026-10-08', endsOn: '2026-10-08' }); const id = (r as { id: number }).id;
    await cal.deleteEvent(P, id); assert.ok(!(await titles(P)).includes('Made by mistake'));
    const a = (await audits('calendar.event_deleted'))[0]!; assert.equal((a.before as { title: string }).title, 'Made by mistake');
  });
  await rejects('editing or deleting an event that does not exist is refused', () => cal.deleteEvent(P, 999999999), 'not found');

  console.log('── validation (server side) ──');
  const bad = async (patch: Record<string, unknown>, fragment: string) => { const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'X', ...patch }); assert.ok(!r.ok && (r as { errors: string[] }).errors.join(' ').includes(fragment), JSON.stringify(r)); };
  await check('no title, bad category, impossible dates, end before start are all refused in plain words', async () => {
    await bad({ title: '  ' }, 'title'); await bad({ category: 'party' }, 'category'); await bad({ startsOn: '2026-02-31' }, 'valid start date');
    await bad({ startsOn: '2026-10-10', endsOn: '2026-10-09' }, 'cannot be before'); await bad({ startsOn: '2026-01-01', endsOn: '2028-01-01' }, 'more than a year');
  });
  await check('times: a timed event needs a start, an end must follow it, and the format is checked', async () => {
    await bad({ allDay: false }, 'start time'); await bad({ allDay: false, startTime: '25:00' }, 'start time'); await bad({ allDay: false, startTime: '10:00', endTime: '09:00' }, 'after the start');
    await bad({ allDay: false, startTime: '10:00', endTime: '9am' }, 'end time');
  });
  await check('audience classes needs classes; repeating needs an end; reminders and links are bounded', async () => {
    await bad({ audience: 'classes' }, 'at least one class'); await bad({ repeat: 'weekly' }, 'when the repeating should stop'); await bad({ repeat: 'weekly', repeatUntil: '2026-09-01' }, 'after the event starts');
    await bad({ repeatEvery: 0, repeat: 'weekly', repeatUntil: '2026-12-01' }, 'from 1 to 52'); await bad({ remindDaysBefore: 90 }, 'from 0 to 60'); await bad({ attachmentUrl: 'javascript:alert(1)' }, 'https://');
  });
  await check('a class from ANOTHER school is refused, and nothing is written', async () => {
    await rejects('foreign class', () => cal.saveEvent(P, F.sessionId, { ...base, title: 'Sneaky', audience: 'classes', classIds: [G.c1.id] }), 'does not belong');
    assert.ok(!(await titles(P)).includes('Sneaky'));
  });
  await check('the database itself refuses an event that ends before it starts', async () => {
    const app = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
    try { await assert.rejects(() => app`insert into calendar_events(school_id,session_id,title,category,starts_on,ends_on) values (${F.schoolId},${F.sessionId},'x','academic','2026-10-10','2026-10-09')`); } finally { await app.end(); }
  });

  console.log('── recurrence ──');
  await check('a weekly event is expanded into the right occurrences', async () => {
    await cal.saveEvent(P, F.sessionId, { ...base, title: 'Assembly', category: 'academic', startsOn: '2026-09-14', endsOn: '2026-09-14', repeat: 'weekly', repeatEvery: 1, repeatUntil: '2026-10-05' });
    const e = (await cal.loadCalendar(P, F.sessionId)).events.find((x) => x.title === 'Assembly')!;
    assert.deepEqual(eng.occurrences(e, '2026-09-01', '2026-12-31').map((x) => x.startsOn), ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
  });

  console.log('── warnings and the recorded override ──');
  let breakId = 0, examEventId = 0;
  await check('a school holiday inside the term is saved, then an exam on it is warned, not silently saved', async () => {
    const h = await cal.saveEvent(P, F.sessionId, { ...base, title: 'Mid-term break', category: 'school_holiday', startsOn: '2026-10-26', endsOn: '2026-10-30' }); assert.ok(h.ok); breakId = (h as { id: number }).id;
    const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'Make-up test', category: 'examination', startsOn: '2026-10-27', endsOn: '2026-10-27' });
    assert.ok(!r.ok && (r as { needsOverride?: boolean }).needsOverride && (r as { warnings: Array<{ kind: string }> }).warnings[0]!.kind === 'exam_in_holiday'); assert.ok(!(await titles(P)).includes('Make-up test'));
  });
  await check('the exam officer cannot override: only the principal or vice principal can', async () => {
    const r = await cal.saveEvent(EO, F.sessionId, { ...base, title: 'Make-up test', category: 'examination', startsOn: '2026-10-27', endsOn: '2026-10-27', overrideNote: 'needed' }, undefined, true);
    assert.ok(!r.ok && (r as { errors: string[] }).errors.join(' ').includes('principal or vice principal'));
  });
  await check('an override needs a reason, then is saved with who and why on the event AND in the audit log', async () => {
    const noWhy = await cal.saveEvent(V, F.sessionId, { ...base, title: 'Make-up test', category: 'examination', startsOn: '2026-10-27', endsOn: '2026-10-27' }, undefined, true);
    assert.ok(!noWhy.ok && (noWhy as { errors: string[] }).errors.join(' ').includes('why'));
    const r = await cal.saveEvent(V, F.sessionId, { ...base, title: 'Make-up test', category: 'examination', startsOn: '2026-10-27', endsOn: '2026-10-27', overrideNote: 'Make-up sitting for the strike week' }, undefined, true);
    assert.ok(r.ok); examEventId = (r as { id: number }).id;
    const [row] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, examEventId));
    assert.equal(Number(row!.warningOverriddenBy), F.vice.id); assert.equal(row!.warningOverrideNote, 'Make-up sitting for the strike week');
    const a = (await audits('calendar.event_created')).find((x) => Number(x.entityId) === examEventId)!; assert.ok((a.reason ?? '').includes('strike week'));
  });
  await check('the page-level warnings list shows the override-saved event as still flagged, for managers only', async () => {
    const v = await cal.loadCalendar(P, F.sessionId); assert.ok(v.conflicts[`e${examEventId}`]?.some((c) => c.kind === 'exam_in_holiday'));
    assert.deepEqual((await cal.loadCalendar(TA, F.sessionId)).conflicts, {});
  });
  await check('a cancelled event is never warned about', async () => {
    const r = await cal.saveEvent(P, F.sessionId, { ...base, title: 'Dropped exam', category: 'examination', startsOn: '2026-10-28', endsOn: '2026-10-28', status: 'cancelled' }); assert.ok(r.ok);
  });

  console.log('── permissions ──');
  await check('teachers, students and parents cannot create, edit, cancel or delete', async () => {
    for (const who of [TA, SG, PG]) {
      await rejects('create', () => cal.saveEvent(who, F.sessionId, { ...base, title: 'Nope' }), 'permission');
      await rejects('edit', () => cal.saveEvent(who, F.sessionId, { ...base, title: 'Nope' }, examEventId), 'permission');
      await rejects('cancel', () => cal.cancelEvent(who, examEventId), 'permission'); await rejects('delete', () => cal.deleteEvent(who, examEventId), 'permission');
    }
  });
  await check('only the principal or vice principal can publish, archive or change the timezone; the exam officer cannot', async () => {
    await rejects('publish', () => cal.setCalendarState(EO, F.sessionId, 'published'), 'principal or vice principal'); await rejects('tz', () => cal.setSchoolTimeZone(EO, 'Africa/Accra'), 'principal or vice principal');
    await rejects('bad tz', () => cal.setSchoolTimeZone(P, 'Mars/Base'), 'recognise');
  });

  console.log('── publishing, archiving and who sees what ──');
  const before = (await cal.loadCalendar(P, F.sessionId)).events.length;
  await check('while the calendar is a draft, only managers see any event', async () => {
    assert.equal((await cal.loadCalendar(TA, F.sessionId)).events.filter((e) => e.source === 'event').length, 0); assert.equal((await cal.loadCalendar(SG, F.sessionId)).events.filter((e) => e.source === 'event').length, 0);
    assert.equal((await cal.loadCalendar(EO, F.sessionId)).events.length, before);
  });
  await cal.saveEvent(P, F.sessionId, { ...base, title: 'Staff retreat', audience: 'staff', startsOn: '2026-11-02', endsOn: '2026-11-02' });
  await cal.saveEvent(P, F.sessionId, { ...base, title: 'Gold class trip', audience: 'classes', classIds: [F.c1.id], startsOn: '2026-11-03', endsOn: '2026-11-03' });
  await cal.saveEvent(P, F.sessionId, { ...base, title: 'Green class trip', audience: 'classes', classIds: [F.c2.id], startsOn: '2026-11-04', endsOn: '2026-11-04' });
  await cal.saveEvent(P, F.sessionId, { ...base, title: 'Parents forum', audience: 'guardians', startsOn: '2026-11-05', endsOn: '2026-11-05' });
  await cal.saveEvent(P, F.sessionId, { ...base, title: 'Secret plan', published: false, startsOn: '2026-11-06', endsOn: '2026-11-06' });
  await cal.saveEvent(P, F.sessionId, { ...base, title: 'Draft idea', status: 'draft', startsOn: '2026-11-09', endsOn: '2026-11-09' });
  const pub = await cal.setCalendarState(P, F.sessionId, 'published');
  await check('publishing notifies the school in-app (not the publisher) and is audited', async () => {
    assert.ok(pub.notified >= 7); const n = await db.select().from(schema.notifications).where(and(eq(schema.notifications.schoolId, F.schoolId), eq(schema.notifications.type, 'calendar_event')));
    assert.equal(n.length, pub.notified); assert.ok(!n.some((x) => Number(x.userId) === F.principal.id)); assert.equal((await audits('calendar.published')).length, 1);
  });
  await check('publishing twice does not notify twice', async () => { assert.equal((await cal.setCalendarState(P, F.sessionId, 'published')).notified, 0); });
  await check('after publishing: an unpublished event and a draft stay with managers only', async () => {
    for (const who of [TA, SG, PG]) { const t = await titles(who); assert.ok(!t.includes('Secret plan') && !t.includes('Draft idea'), `${who.role} must not see them`); }
    const m = await titles(EO); assert.ok(m.includes('Secret plan') && m.includes('Draft idea'));
  });
  await check('audience: staff-only stays with staff; guardians-only goes to parents; class events go to that class', async () => {
    assert.ok((await titles(TA)).includes('Staff retreat')); assert.ok(!(await titles(SG)).includes('Staff retreat')); assert.ok(!(await titles(PG)).includes('Staff retreat'));
    assert.ok((await titles(PG)).includes('Parents forum')); assert.ok(!(await titles(SG)).includes('Parents forum')); assert.ok(!(await titles(TA)).includes('Parents forum'));
    assert.ok((await titles(SG)).includes('Gold class trip') && !(await titles(SG)).includes('Green class trip'));
    assert.ok((await titles(SR)).includes('Green class trip') && !(await titles(SR)).includes('Gold class trip'));
    assert.ok((await titles(PG)).includes('Gold class trip') && !(await titles(PG)).includes('Green class trip'), 'a parent sees their child\'s class');
    assert.ok((await titles(TA)).includes('Gold class trip') && !(await titles(TA)).includes('Green class trip'), 'a teacher sees the classes they teach');
    assert.ok((await titles(TB)).includes('Green class trip') && !(await titles(TB)).includes('Gold class trip'));
  });
  await check('everyone-events reach every role', async () => { for (const who of [TA, TB, SG, SR, PG]) assert.ok((await titles(who)).includes('PTA meeting'), who.role); });
  await check('archiving keeps it readable, and returning it to draft hides it again', async () => {
    await cal.setCalendarState(P, F.sessionId, 'archived'); assert.equal((await cal.loadCalendar(P, F.sessionId)).state, 'archived');
    await cal.setCalendarState(P, F.sessionId, 'draft'); assert.equal((await cal.loadCalendar(TA, F.sessionId)).events.filter((e) => e.source === 'event').length, 0);
    await cal.setCalendarState(P, F.sessionId, 'published');
  });

  console.log('── examinations: read from the exam records, never copied ──');
  const [series] = await db.insert(schema.examSeries).values({ schoolId: F.schoolId, sessionId: F.sessionId, termId: F.terms[0]!.id, title: 'First Term Examination', seriesType: 'examination', status: 'published' }).returning();
  const [subject] = await db.insert(schema.subjects).values({ schoolId: F.schoolId, name: 'Mathematics', code: 'MTH' }).returning();
  const [paper] = await db.insert(schema.examPapers).values({ schoolId: F.schoolId, seriesId: series!.id, subjectId: subject!.id, classId: F.c1.id, scheduledAt: new Date('2026-11-23T08:00:00Z'), closesAt: new Date('2026-11-23T09:30:00Z'), durationSeconds: 5400 }).returning();
  const examOf = async (a: Actor) => (await cal.loadCalendar(a, F.sessionId)).events.find((e) => e.source === 'exam');
  await check('a scheduled exam appears on the calendar with its title, dates and class, and no copy is stored', async () => {
    const e = (await examOf(P))!; assert.ok(e); assert.equal(e.title, 'First Term Examination'); assert.equal(e.category, 'examination'); assert.equal(e.startsOn, '2026-11-23'); assert.deepEqual(e.classIds, [F.c1.id]);
    assert.equal(e.manageHref, `/portal/exams/${series!.id}`); const stored = await db.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.schoolId, F.schoolId), eq(schema.calendarEvents.title, 'First Term Examination'))); assert.equal(stored.length, 0);
  });
  await check('moving the paper moves the calendar entry, with nothing to sync', async () => {
    await db.update(schema.examPapers).set({ scheduledAt: new Date('2026-11-25T08:00:00Z'), closesAt: new Date('2026-11-25T09:30:00Z') }).where(eq(schema.examPapers.id, paper!.id));
    assert.equal((await examOf(P))!.startsOn, '2026-11-25');
  });
  await check('an exam late in the evening lands on the SCHOOL\'s day, not the UTC day', async () => {
    await db.update(schema.examPapers).set({ scheduledAt: new Date('2026-11-25T23:30:00Z'), closesAt: new Date('2026-11-26T00:30:00Z') }).where(eq(schema.examPapers.id, paper!.id));
    assert.equal((await examOf(P))!.startsOn, '2026-11-26', '23:30 UTC is already the 26th in Lagos'); await cal.setSchoolTimeZone(P, 'UTC'); assert.equal((await examOf(P))!.startsOn, '2026-11-25');
    await cal.setSchoolTimeZone(P, 'Africa/Lagos');
  });
  await check('an exam entry cannot be edited, cancelled or deleted as a calendar event', async () => {
    await rejects('edit', () => cal.saveEvent(P, F.sessionId, { ...base, title: 'Hijack', category: 'examination' }, series!.id), 'not found');
    await rejects('cancel', () => cal.cancelEvent(P, series!.id), 'not found'); await rejects('delete', () => cal.deleteEvent(P, series!.id), 'not found'); assert.ok(await examOf(P));
  });
  await check('cancelling the examination cancels its entry; a draft series with no dates is not shown', async () => {
    await db.update(schema.examSeries).set({ status: 'cancelled' }).where(eq(schema.examSeries.id, series!.id)); assert.equal((await examOf(P))!.status, 'cancelled');
    await db.update(schema.examSeries).set({ status: 'published' }).where(eq(schema.examSeries.id, series!.id));
    await db.insert(schema.examSeries).values({ schoolId: F.schoolId, sessionId: F.sessionId, title: 'Undated draft', seriesType: 'examination', status: 'draft' });
    assert.ok(!(await cal.loadCalendar(P, F.sessionId)).events.some((e) => e.title === 'Undated draft'));
  });
  await check('exams are shown to the classes concerned: a Gold student and parent see it, a Green student does not; a teacher does', async () => {
    assert.ok(await examOf(SG)); assert.ok(await examOf(PG)); assert.ok(await examOf(TA)); assert.ok(!(await examOf(SR)));
  });
  await check('an unpublished exam series stays with the exam office, exactly as on the timetable', async () => {
    await db.update(schema.examSeries).set({ status: 'open' }).where(eq(schema.examSeries.id, series!.id));
    assert.ok(await examOf(P)); assert.ok(await examOf(EO)); assert.ok(!(await examOf(TA))); assert.ok(!(await examOf(SG))); await db.update(schema.examSeries).set({ status: 'published' }).where(eq(schema.examSeries.id, series!.id));
  });
  await check('an exam on a holiday is flagged for managers and a collision with another exam is found', async () => {
    await cal.saveEvent(P, F.sessionId, { ...base, title: 'Public holiday', category: 'public_holiday', startsOn: '2026-11-26', endsOn: '2026-11-26' }, undefined, false);
    assert.ok((await cal.loadCalendar(P, F.sessionId)).conflicts[`x${series!.id}`]?.some((c) => c.kind === 'exam_in_holiday'));
  });

  console.log('── progress is computed from real data ──');
  await check('instructional weeks and days come from the school\'s own terms and holidays', async () => {
    const v = await cal.loadCalendar(P, F.sessionId); const p = eng.progress(v.terms, v.events, '2026-10-01');
    assert.ok(p.totalDays > 60 && p.doneDays > 0 && p.remainingDays > 0); assert.equal(p.currentWeek, 3);
  });

  console.log('── tenant isolation ──');
  await check('another school sees none of this school\'s events, calendar state or exams', async () => {
    const o = await cal.loadCalendar(PB, G.sessionId); assert.equal(o.events.length, 0); assert.equal(o.state, 'draft');
  });
  await check('asking for ANOTHER school\'s session id does not leak it or let you write to it', async () => {
    const asked = await cal.loadCalendar(PB, F.sessionId); assert.notEqual(asked.session?.id, F.sessionId); assert.equal(asked.events.length, 0);
    await rejects('write to their session', () => cal.saveEvent(PB, F.sessionId, { ...base, title: 'Intruder' }), 'session was not found');
    await rejects('publish their calendar', () => cal.setCalendarState(PB, F.sessionId, 'published'), 'not found');
  });
  await check('another school cannot edit, cancel or delete our event by id', async () => {
    await rejects('edit', () => cal.saveEvent(PB, G.sessionId, { ...base, title: 'Intruder' }, examEventId), 'not found'); await rejects('cancel', () => cal.cancelEvent(PB, examEventId), 'not found'); await rejects('delete', () => cal.deleteEvent(PB, examEventId), 'not found');
    assert.ok((await titles(P)).includes('Make-up test'));
  });
  await check('RLS: a tenantless connection sees no calendar rows at all', async () => {
    const app = postgres(process.env.DATABASE_URL_APP!, { max: 1, onnotice: () => {} });
    try { for (const t of ['academic_calendars', 'calendar_events', 'calendar_event_classes']) assert.equal((await app`select count(*)::int as n from ${app(t)}`)[0]!.n, 0, t); } finally { await app.end(); }
  });
  await check('RLS: school B\'s connection cannot read or change school A\'s rows even with a direct query', async () => {
    const r = await forSchool(G.schoolId, async (tx) => ({ read: await tx.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.schoolId, F.schoolId)), upd: await tx.update(schema.calendarEvents).set({ title: 'pwned' }).where(eq(schema.calendarEvents.schoolId, F.schoolId)).returning() }));
    assert.equal(r.read.length, 0); assert.equal(r.upd.length, 0);
  });

  console.log(`\nCALENDAR OK: ${count} checks passed.`);
  await appSingleton.end().catch(() => {});
  await owner.end();
}

main().catch(async (err) => { console.error(err); process.exitCode = 1; });
