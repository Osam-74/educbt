/**
 * Calendar reminders. For each active school, in that school's own timezone, tell the people an
 * event is for that it is coming up: N days before its start, where N is the event's own setting.
 *
 * Properties (each pinned by test-calendar-reminders.ts):
 *   - once per event: reminder_sent_at is set in the SAME transaction as the notifications, so a
 *     crash cannot send twice and a retry cannot skip;
 *   - only published events on a PUBLISHED calendar, never a draft, a cancelled or a completed one;
 *   - the audience is exactly who may see the event (staff only stays with staff, a class event goes
 *     to that class's students, parents and teachers);
 *   - a late run still sends (the reminder day has passed but the event has not), an old event never does;
 *   - one school failing never stops the others, and nothing here ever throws on an empty school.
 */
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db, forSchool, schema, type Tx } from '@/db';
import { notifyMany } from '@/lib/comms/notifications';
import { addDays, cmp, todayIn } from '@/lib/calendar/dates';
import { schoolTimeZone } from '@/lib/calendar/service';

export type ReminderSummary = { schoolsConsidered: number; remindersSent: number; notificationsCreated: number; failures: Array<{ schoolId: number; error: string }> };

const CATEGORY_WORD: Record<string, string> = { examination: 'Examination', ceremonial: 'Ceremony', deadline: 'Deadline', public_holiday: 'Public holiday', school_holiday: 'School holiday' };

/** The user ids an event is for. Mirrors canSee() in access.ts, resolved to people. */
async function audienceUsers(tx: Tx, schoolId: number, sessionId: number, audience: string, classIds: number[]): Promise<number[]> {
  const ids = new Set<number>();
  const byRole = async (roles: Array<'principal' | 'vice_principal' | 'exam_officer' | 'teacher' | 'student' | 'parent'>) => {
    const rows = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.schoolId, schoolId), eq(schema.users.status, 'active'), inArray(schema.users.role, roles)));
    rows.forEach((r) => ids.add(Number(r.id)));
  };
  switch (audience) {
    case 'everyone': await byRole(['principal', 'vice_principal', 'exam_officer', 'teacher', 'student', 'parent']); break;
    case 'staff': await byRole(['principal', 'vice_principal', 'exam_officer', 'teacher']); break;
    case 'teachers': await byRole(['teacher']); break;
    case 'students': await byRole(['student']); break;
    case 'guardians': await byRole(['parent']); break;
    case 'classes': {
      if (!classIds.length) break;
      const stu = await tx.select({ id: schema.students.userId }).from(schema.enrollments).innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
        .where(and(eq(schema.enrollments.schoolId, schoolId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active'), inArray(schema.enrollments.classId, classIds)));
      stu.forEach((r) => r.id && ids.add(Number(r.id)));
      const par = await tx.select({ id: schema.guardians.userId }).from(schema.enrollments).innerJoin(schema.guardianStudent, eq(schema.guardianStudent.studentId, schema.enrollments.studentId)).innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId))
        .where(and(eq(schema.enrollments.schoolId, schoolId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active'), inArray(schema.enrollments.classId, classIds)));
      par.forEach((r) => r.id && ids.add(Number(r.id)));
      const tch = await tx.select({ id: schema.staff.userId }).from(schema.staffAssignments).innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
        .where(and(eq(schema.staffAssignments.schoolId, schoolId), eq(schema.staffAssignments.status, 'active'), inArray(schema.staffAssignments.classId, classIds)));
      tch.forEach((r) => r.id && ids.add(Number(r.id)));
      await byRole(['principal', 'vice_principal', 'exam_officer']);
      break;
    }
  }
  return [...ids].filter((n) => n > 0);
}

export async function sendRemindersForSchool(schoolId: number, now: Date = new Date()): Promise<{ events: number; notifications: number }> {
  return forSchool(schoolId, async (tx) => {
    const tz = await schoolTimeZone(tx, schoolId);
    const today = todayIn(tz, now);
    const due = await tx.select().from(schema.calendarEvents).where(and(
      eq(schema.calendarEvents.schoolId, schoolId), eq(schema.calendarEvents.status, 'scheduled'), eq(schema.calendarEvents.published, true),
      isNull(schema.calendarEvents.reminderSentAt), gt(schema.calendarEvents.remindDaysBefore, 0), gt(schema.calendarEvents.endsOn, addDays(today, -1)),
    ));
    let events = 0, notifications = 0;
    for (const e of due) {
      // Not yet time (more than N days away), or the event has already started: nothing to remind.
      if (cmp(addDays(today, e.remindDaysBefore), e.startsOn) < 0) continue;
      if (cmp(e.startsOn, today) < 0) continue;
      const [cal] = await tx.select().from(schema.academicCalendars).where(and(eq(schema.academicCalendars.schoolId, schoolId), eq(schema.academicCalendars.sessionId, e.sessionId))).limit(1);
      if (cal?.state !== 'published') continue;
      const cls = await tx.select({ c: schema.calendarEventClasses.classId }).from(schema.calendarEventClasses).where(and(eq(schema.calendarEventClasses.schoolId, schoolId), eq(schema.calendarEventClasses.eventId, e.id)));
      const users = await audienceUsers(tx, schoolId, Number(e.sessionId), e.audience, cls.map((c) => Number(c.c)));
      const days = Math.max(0, Math.round((Date.parse(`${e.startsOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
      const lead = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
      const body = [CATEGORY_WORD[e.category] ?? 'Event', e.startsOn === e.endsOn ? e.startsOn : `${e.startsOn} to ${e.endsOn}`, e.venue].filter(Boolean).join(' · ');
      // Mark first inside the same transaction: if anything below throws, both roll back together.
      const claimed = await tx.update(schema.calendarEvents).set({ reminderSentAt: now }).where(and(eq(schema.calendarEvents.id, e.id), isNull(schema.calendarEvents.reminderSentAt))).returning({ id: schema.calendarEvents.id });
      if (!claimed.length) continue;
      notifications += await notifyMany(tx, schoolId, users.map((userId) => ({ userId, type: 'calendar_event' as const, title: `${e.title} is ${lead}`, body, link: '/portal/calendar' })));
      events++;
    }
    return { events, notifications };
  });
}

export async function sendAllCalendarReminders(now: Date = new Date()): Promise<ReminderSummary> {
  const schools = await db.select({ id: schema.schools.id }).from(schema.schools).where(eq(schema.schools.status, 'active'));
  const out: ReminderSummary = { schoolsConsidered: schools.length, remindersSent: 0, notificationsCreated: 0, failures: [] };
  for (const s of schools) {
    try { const r = await sendRemindersForSchool(Number(s.id), now); out.remindersSent += r.events; out.notificationsCreated += r.notifications; }
    catch (err) { out.failures.push({ schoolId: Number(s.id), error: err instanceof Error ? err.message : String(err) }); }
  }
  return out;
}
