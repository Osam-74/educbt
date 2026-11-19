/**
 * The calendar's database layer. Everything goes through forSchool(actor.schoolId)
 * so row-level security applies; the school id always comes from the SESSION
 * (the Actor), never from a form field.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { notifyMany } from '@/lib/comms/notifications';
import { type DateStr, addDays, isValidTimeZone, toLocalDate, toLocalTime, todayIn } from './dates';
import { type CalEvent, type Conflict, type Term, conflictsFor } from './engine';
import { canPublish, canSee, canSeeExam, isManager, type Viewer } from './access';
import { validateEvent, type EventInput } from './validate';

export class CalendarError extends Error {}

export const DEFAULT_TIMEZONE = 'Africa/Lagos';

const iso = (d: Date | null | undefined): DateStr | null => (d ? d.toISOString().slice(0, 10) : null);

export async function schoolTimeZone(tx: Tx, schoolId: number): Promise<string> {
  const [row] = await tx.select({ settings: schema.schools.settings }).from(schema.schools).where(eq(schema.schools.id, schoolId)).limit(1);
  const tz = (row?.settings as { timezone?: unknown } | undefined)?.timezone;
  return typeof tz === 'string' && isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

export async function setSchoolTimeZone(actor: Actor, timeZone: string): Promise<void> {
  if (!canPublish(actor.role)) throw new CalendarError('Only the principal or vice principal can change the school timezone.');
  if (!isValidTimeZone(timeZone)) throw new CalendarError('That is not a timezone we recognise.');
  await forSchool(actor.schoolId, async (tx) => {
    const before = await schoolTimeZone(tx, actor.schoolId);
    await tx.update(schema.schools)
      .set({ settings: sql`jsonb_set(coalesce(${schema.schools.settings}, '{}'::jsonb), '{timezone}', to_jsonb(${timeZone}::text))` })
      .where(eq(schema.schools.id, actor.schoolId));
    await audit(tx, actor, 'calendar.timezone_changed', 'schools', actor.schoolId, { timeZone: before }, { timeZone });
  });
}

async function audit(tx: Tx, actor: Actor, action: string, entityType: string, entityId: number | null, before: unknown, after: unknown, reason?: string) {
  await tx.insert(schema.auditLog).values({
    schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role, action, entityType,
    entityId: entityId ?? undefined, before: before as never, after: after as never, reason: reason || null,
  });
}

export type SessionOption = { id: number; title: string; isCurrent: boolean; startsOn: DateStr | null; endsOn: DateStr | null };

export async function listSessions(tx: Tx, schoolId: number): Promise<SessionOption[]> {
  const rows = await tx.select().from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, schoolId)).orderBy(sql`${schema.academicSessions.startsOn} desc nulls last`, sql`${schema.academicSessions.id} desc`);
  return rows.map((r) => ({ id: Number(r.id), title: r.title, isCurrent: r.isCurrent, startsOn: iso(r.startsOn), endsOn: iso(r.endsOn) }));
}

export async function termsOf(tx: Tx, schoolId: number, sessionId: number): Promise<Term[]> {
  const rows = await tx.select().from(schema.terms).where(and(eq(schema.terms.schoolId, schoolId), eq(schema.terms.sessionId, sessionId))).orderBy(asc(schema.terms.position));
  return rows.map((t) => ({ id: Number(t.id), title: t.title, position: t.position, startsOn: iso(t.startsOn), endsOn: iso(t.endsOn) }));
}

/** The classes this person is connected to: a teacher's duties, a student's enrolment, a parent's children's classes. */
export async function viewerOf(tx: Tx, actor: Actor, sessionId: number): Promise<Viewer> {
  const ids = new Set<number>();
  if (actor.role === 'teacher' || actor.role === 'exam_officer') {
    if (actor.staffId) {
      const rows = await tx.select({ c: schema.staffAssignments.classId }).from(schema.staffAssignments)
        .where(and(eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId), eq(schema.staffAssignments.status, 'active')));
      rows.forEach((r) => r.c && ids.add(Number(r.c)));
    }
  } else if (actor.role === 'student' && actor.studentId) {
    const rows = await tx.select({ c: schema.enrollments.classId }).from(schema.enrollments)
      .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.studentId, actor.studentId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
    rows.forEach((r) => ids.add(Number(r.c)));
  } else if (actor.role === 'parent') {
    const rows = await tx.select({ c: schema.enrollments.classId }).from(schema.guardians)
      .innerJoin(schema.guardianStudent, eq(schema.guardianStudent.guardianId, schema.guardians.id))
      .innerJoin(schema.enrollments, eq(schema.enrollments.studentId, schema.guardianStudent.studentId))
      .where(and(eq(schema.guardians.userId, actor.userId), eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
    rows.forEach((r) => ids.add(Number(r.c)));
  }
  return { role: actor.role, classIds: [...ids] };
}

async function eventClassMap(tx: Tx, schoolId: number, eventIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (!eventIds.length) return map;
  const rows = await tx.select().from(schema.calendarEventClasses).where(and(eq(schema.calendarEventClasses.schoolId, schoolId), inArray(schema.calendarEventClasses.eventId, eventIds)));
  for (const r of rows) { const k = Number(r.eventId); map.set(k, [...(map.get(k) ?? []), Number(r.classId)]); }
  return map;
}

function toCalEvent(r: typeof schema.calendarEvents.$inferSelect, classIds: number[]): CalEvent {
  return {
    key: `e${r.id}`, id: Number(r.id), source: 'event', title: r.title, category: r.category, status: r.status,
    startsOn: r.startsOn, endsOn: r.endsOn, startTime: r.startTime ? r.startTime.slice(0, 5) : null, endTime: r.endTime ? r.endTime.slice(0, 5) : null,
    allDay: r.allDay, venue: r.venue, description: r.description, audience: r.audience, classIds, published: r.published,
    repeat: r.repeat, repeatEvery: r.repeatEvery, repeatUntil: r.repeatUntil, overridden: !!r.warningOverriddenBy,
  };
}

/**
 * Examinations as calendar entries, built from the exam records on every read:
 * nothing is stored twice, so a rescheduled paper is already rescheduled here.
 * One entry per examination or CA series, spanning its sitting window (or, until
 * a window is set, the dates of its papers). Not editable here: manageHref
 * points to the place that owns it.
 */
export async function examEntries(tx: Tx, schoolId: number, sessionId: number, tz: string): Promise<Array<CalEvent & { seriesStatus: string }>> {
  const series = await tx.select().from(schema.examSeries).where(and(
    eq(schema.examSeries.schoolId, schoolId), eq(schema.examSeries.sessionId, sessionId), inArray(schema.examSeries.seriesType, ['examination', 'ca_test']),
  ));
  const live = series.filter((s) => s.status !== 'draft' || s.sittingOpensAt);
  if (!live.length) return [];
  const papers = await tx.select({
    seriesId: schema.examPapers.seriesId, scheduledAt: schema.examPapers.scheduledAt, closesAt: schema.examPapers.closesAt, classId: schema.examPapers.classId,
  }).from(schema.examPapers).where(and(eq(schema.examPapers.schoolId, schoolId), inArray(schema.examPapers.seriesId, live.map((s) => s.id))));

  const out: Array<CalEvent & { seriesStatus: string }> = [];
  for (const s of live) {
    const mine = papers.filter((p) => Number(p.seriesId) === Number(s.id));
    const starts = [s.sittingOpensAt, ...mine.map((p) => p.scheduledAt)].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime());
    const ends = [s.sittingClosesAt, ...mine.map((p) => p.closesAt ?? p.scheduledAt)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime());
    if (!starts.length) continue;
    const startsOn = toLocalDate(starts[0]!, tz), endsOn = ends.length ? toLocalDate(ends[0]!, tz) : startsOn;
    const single = startsOn === endsOn;
    out.push({
      key: `x${s.id}`, id: Number(s.id), source: 'exam', title: s.title, category: 'examination',
      status: s.status === 'cancelled' ? 'cancelled' : s.status === 'closed' ? 'completed' : 'scheduled',
      startsOn, endsOn: endsOn < startsOn ? startsOn : endsOn,
      startTime: single ? toLocalTime(starts[0]!, tz) : null, endTime: single && ends.length ? toLocalTime(ends[0]!, tz) : null, allDay: !single,
      venue: '', description: s.seriesType === 'ca_test' ? 'Continuous assessment test' : 'Examination',
      audience: 'classes', classIds: [...new Set(mine.map((p) => (p.classId ? Number(p.classId) : 0)).filter(Boolean))],
      published: true, repeat: 'none', repeatEvery: 1, repeatUntil: null, manageHref: `/portal/exams/${s.id}`,
      seriesStatus: s.status,
    });
  }
  return out;
}

export type CalendarState = 'draft' | 'published' | 'archived';

export async function getCalendarState(tx: Tx, schoolId: number, sessionId: number): Promise<{ state: CalendarState; publishedAt: Date | null; shareToken: string | null }> {
  const [row] = await tx.select().from(schema.academicCalendars).where(and(eq(schema.academicCalendars.schoolId, schoolId), eq(schema.academicCalendars.sessionId, sessionId))).limit(1);
  return { state: row?.state ?? 'draft', publishedAt: row?.publishedAt ?? null, shareToken: row?.shareToken ?? null };
}

export type CalendarView = {
  timeZone: string; today: DateStr; sessions: SessionOption[]; session: SessionOption | null; terms: Term[];
  state: CalendarState; publishedAt: Date | null; shareOn: boolean; canManage: boolean; canPublish: boolean;
  events: CalEvent[];
  /** Warnings for each event the viewer can manage, by event key. Managers only. */
  conflicts: Record<string, Conflict[]>;
};

/** Everything the calendar page needs, already restricted to what this person may see. */
export async function loadCalendar(actor: Actor, sessionId?: number): Promise<CalendarView> {
  return forSchool(actor.schoolId, async (tx) => {
    const tz = await schoolTimeZone(tx, actor.schoolId);
    const sessions = await listSessions(tx, actor.schoolId);
    const session = sessions.find((s) => s.id === sessionId) ?? sessions.find((s) => s.isCurrent) ?? sessions[0] ?? null;
    const base = { timeZone: tz, today: todayIn(tz), sessions, canManage: isManager(actor.role), canPublish: canPublish(actor.role) };
    if (!session) return { ...base, session: null, terms: [], state: 'draft' as const, publishedAt: null, shareOn: false, events: [], conflicts: {} };

    const terms = await termsOf(tx, actor.schoolId, session.id);
    const cal = await getCalendarState(tx, actor.schoolId, session.id);
    const viewer = await viewerOf(tx, actor, session.id);
    const rows = await tx.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.schoolId, actor.schoolId), eq(schema.calendarEvents.sessionId, session.id))).orderBy(asc(schema.calendarEvents.startsOn));
    const classes = await eventClassMap(tx, actor.schoolId, rows.map((r) => Number(r.id)));
    const stored = rows.map((r) => toCalEvent(r, classes.get(Number(r.id)) ?? []));
    const exams = (await examEntries(tx, actor.schoolId, session.id, tz)).filter((x) => canSeeExam(x.seriesStatus, viewer, x.classIds));

    // The calendar's publish state gates what non-managers see; exams follow their own published rule above.
    const visible = [...stored.filter((e) => canSee(e, viewer, cal.state === 'published')), ...exams].sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title));

    const conflicts: Record<string, Conflict[]> = {};
    if (isManager(actor.role)) {
      const ctx = { terms, others: visible, sessionStart: session.startsOn, sessionEnd: session.endsOn };
      for (const e of visible) { const c = conflictsFor(e, ctx); if (c.length) conflicts[e.key] = c; }
    }
    return { ...base, session, terms, state: cal.state, publishedAt: cal.publishedAt, shareOn: !!cal.shareToken, events: visible, conflicts };
  });
}

// ── writing ──────────────────────────────────────────────────────────────

function requireManager(actor: Actor) {
  if (!isManager(actor.role)) throw new CalendarError('You do not have permission to change the calendar.');
}

async function ownSession(tx: Tx, schoolId: number, sessionId: number) {
  const [s] = await tx.select().from(schema.academicSessions).where(and(eq(schema.academicSessions.id, sessionId), eq(schema.academicSessions.schoolId, schoolId))).limit(1);
  if (!s) throw new CalendarError('That academic session was not found.');
  return s;
}

async function assertClassesBelong(tx: Tx, schoolId: number, classIds: number[]) {
  if (!classIds.length) return;
  const rows = await tx.select({ id: schema.classes.id }).from(schema.classes).where(and(eq(schema.classes.schoolId, schoolId), inArray(schema.classes.id, classIds)));
  if (rows.length !== classIds.length) throw new CalendarError('One of the chosen classes does not belong to this school.');
}

async function warningsFor(tx: Tx, actor: Actor, sessionId: number, input: EventInput, selfKey: string) {
  const s = await ownSession(tx, actor.schoolId, sessionId);
  const terms = await termsOf(tx, actor.schoolId, sessionId);
  const tz = await schoolTimeZone(tx, actor.schoolId);
  const rows = await tx.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.schoolId, actor.schoolId), eq(schema.calendarEvents.sessionId, sessionId)));
  const cls = await eventClassMap(tx, actor.schoolId, rows.map((r) => Number(r.id)));
  const others = [...rows.map((r) => toCalEvent(r, cls.get(Number(r.id)) ?? [])), ...(await examEntries(tx, actor.schoolId, sessionId, tz))];
  const probe: CalEvent = { key: selfKey, id: 0, source: 'event', title: input.title, category: input.category, status: input.status, startsOn: input.startsOn, endsOn: input.endsOn, startTime: input.startTime, endTime: input.endTime, allDay: input.allDay, venue: input.venue, description: input.description, audience: input.audience, classIds: input.classIds, published: input.published, repeat: input.repeat, repeatEvery: input.repeatEvery, repeatUntil: input.repeatUntil };
  return conflictsFor(probe, { terms, others, sessionStart: iso(s.startsOn), sessionEnd: iso(s.endsOn) });
}

export type SaveResult = { ok: true; id: number; warnings: Conflict[] } | { ok: false; errors: string[]; warnings?: Conflict[]; needsOverride?: boolean };

/**
 * Create (id omitted) or update an event. Warnings never block by themselves,
 * but saving past one needs the manager to say so (`override`) and the
 * principal or vice principal to be the one doing it; who and why are kept.
 */
export async function saveEvent(actor: Actor, sessionId: number, raw: Record<string, unknown>, id?: number, override = false): Promise<SaveResult> {
  requireManager(actor);
  const parsed = validateEvent(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const v = parsed.value;

  return forSchool(actor.schoolId, async (tx) => {
    await ownSession(tx, actor.schoolId, sessionId);
    await assertClassesBelong(tx, actor.schoolId, v.classIds);

    let before: typeof schema.calendarEvents.$inferSelect | undefined;
    if (id) {
      [before] = await tx.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.id, id), eq(schema.calendarEvents.schoolId, actor.schoolId))).limit(1);
      if (!before) throw new CalendarError('That event was not found.');
      if (Number(before.sessionId) !== sessionId) throw new CalendarError('That event belongs to a different academic session.');
    }

    const warnings = v.status === 'cancelled' ? [] : await warningsFor(tx, actor, sessionId, v, id ? `e${id}` : 'new');
    if (warnings.length && !override) return { ok: false as const, errors: [], warnings, needsOverride: true };
    if (warnings.length && override && !canPublish(actor.role)) {
      return { ok: false as const, errors: ['Only the principal or vice principal can save an event that has a warning. Fix the warning or ask them to save it.'], warnings };
    }
    if (warnings.length && !v.overrideNote) return { ok: false as const, errors: ['Say briefly why this is intended, so there is a record.'], warnings, needsOverride: true };

    const values = {
      title: v.title, description: v.description, category: v.category, status: v.status, startsOn: v.startsOn, endsOn: v.endsOn,
      startTime: v.allDay ? null : v.startTime, endTime: v.allDay ? null : v.endTime, allDay: v.allDay, venue: v.venue, audience: v.audience,
      staffGroup: v.staffGroup, attachmentUrl: v.attachmentUrl, repeat: v.repeat, repeatEvery: v.repeatEvery, repeatUntil: v.repeatUntil,
      remindDaysBefore: v.remindDaysBefore, published: v.published,
      warningOverriddenBy: warnings.length ? actor.userId : null, warningOverrideNote: warnings.length ? v.overrideNote : '',
      updatedAt: new Date(),
    };
    let eventId: number;
    if (id) {
      // A changed date means the reminder has to be able to fire again.
      const moved = before!.startsOn !== v.startsOn || before!.remindDaysBefore !== v.remindDaysBefore;
      await tx.update(schema.calendarEvents).set({ ...values, ...(moved ? { reminderSentAt: null } : {}) }).where(and(eq(schema.calendarEvents.id, id), eq(schema.calendarEvents.schoolId, actor.schoolId)));
      eventId = id;
    } else {
      const [row] = await tx.insert(schema.calendarEvents).values({ ...values, schoolId: actor.schoolId, sessionId, createdBy: actor.userId }).returning({ id: schema.calendarEvents.id });
      eventId = Number(row!.id);
    }
    await tx.delete(schema.calendarEventClasses).where(and(eq(schema.calendarEventClasses.eventId, eventId), eq(schema.calendarEventClasses.schoolId, actor.schoolId)));
    if (v.classIds.length) await tx.insert(schema.calendarEventClasses).values(v.classIds.map((classId) => ({ schoolId: actor.schoolId, eventId, classId })));

    await audit(tx, actor, id ? 'calendar.event_updated' : 'calendar.event_created', 'calendar_events', eventId,
      before ? { title: before.title, startsOn: before.startsOn, endsOn: before.endsOn, status: before.status, category: before.category } : null,
      { title: v.title, startsOn: v.startsOn, endsOn: v.endsOn, status: v.status, category: v.category, warnings: warnings.map((w) => w.kind) },
      warnings.length ? `Warning overridden: ${v.overrideNote}` : undefined);
    return { ok: true as const, id: eventId, warnings };
  });
}

/** Cancelling keeps the event and marks it; it stays in the record. Delete is for events made by mistake. */
export async function cancelEvent(actor: Actor, id: number): Promise<void> {
  requireManager(actor);
  await forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.id, id), eq(schema.calendarEvents.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new CalendarError('That event was not found.');
    await tx.update(schema.calendarEvents).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(schema.calendarEvents.id, id));
    await audit(tx, actor, 'calendar.event_cancelled', 'calendar_events', id, { status: row.status }, { status: 'cancelled' });
  });
}

export async function deleteEvent(actor: Actor, id: number): Promise<void> {
  requireManager(actor);
  await forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.id, id), eq(schema.calendarEvents.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new CalendarError('That event was not found.');
    await tx.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    await audit(tx, actor, 'calendar.event_deleted', 'calendar_events', id, { title: row.title, startsOn: row.startsOn, endsOn: row.endsOn, category: row.category }, null);
  });
}

/** Publish, archive or return to draft. Publishing tells staff, and everyone it applies to, in-app. */
export async function setCalendarState(actor: Actor, sessionId: number, state: CalendarState): Promise<{ notified: number }> {
  if (!canPublish(actor.role)) throw new CalendarError('Only the principal or vice principal can publish or archive the calendar.');
  return forSchool(actor.schoolId, async (tx) => {
    const session = await ownSession(tx, actor.schoolId, sessionId);
    const before = await getCalendarState(tx, actor.schoolId, sessionId);
    await tx.insert(schema.academicCalendars).values({ schoolId: actor.schoolId, sessionId, state, publishedAt: state === 'published' ? new Date() : null, publishedBy: state === 'published' ? actor.userId : null })
      .onConflictDoUpdate({ target: [schema.academicCalendars.schoolId, schema.academicCalendars.sessionId], set: { state, ...(state === 'published' ? { publishedAt: new Date(), publishedBy: actor.userId } : {}), ...(state === 'archived' ? { shareToken: null } : {}) } });
    await audit(tx, actor, `calendar.${state === 'published' ? 'published' : state === 'archived' ? 'archived' : 'unpublished'}`, 'academic_calendars', sessionId, { state: before.state }, { state });

    let notified = 0;
    if (state === 'published' && before.state !== 'published') {
      const users = await tx.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.schoolId, actor.schoolId), eq(schema.users.status, 'active'), inArray(schema.users.role, ['principal', 'vice_principal', 'exam_officer', 'teacher', 'parent', 'student'])));
      notified = await notifyMany(tx, actor.schoolId, users.filter((u) => Number(u.id) !== actor.userId).map((u) => ({ userId: Number(u.id), type: 'calendar_event' as const, title: `The ${session.title} academic calendar is published`, body: 'See the term dates, examinations, holidays and events.', link: '/portal/calendar' })));
    }
    return { notified };
  });
}
