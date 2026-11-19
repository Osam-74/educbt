/**
 * Class teaching timetable: database layer. School id always comes from the
 * session; every write re-checks the person's right to edit THAT class on the
 * server, and the unique indexes catch a clash two simultaneous saves would miss.
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { notifyMany } from '@/lib/comms/notifications';
import { CalendarError, listSessions, termsOf, schoolTimeZone } from './service';
import { isManager } from './access';
import { canEditClassTimetable, canEditPeriods, lessonProblems, periodsProblems, type Period, type LessonRow } from './timetable-rules';
import { instructionalDays, type CalEvent } from './engine';
import { todayIn } from './dates';

const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '');

async function audit(tx: Tx, actor: Actor, action: string, entityType: string, entityId: number | null, before: unknown, after: unknown) {
  await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role, action, entityType, entityId: entityId ?? undefined, before: before as never, after: after as never });
}

export async function periodsOf(tx: Tx, schoolId: number): Promise<Period[]> {
  const rows = await tx.select().from(schema.timetablePeriods).where(eq(schema.timetablePeriods.schoolId, schoolId)).orderBy(asc(schema.timetablePeriods.position));
  return rows.map((p) => ({ id: Number(p.id), name: p.name, position: p.position, startTime: hhmm(p.startTime), endTime: hhmm(p.endTime), isBreak: p.isBreak }));
}

/** The classes this person is CLASS TEACHER of (a subject teacher is not). */
export async function classTeacherClasses(tx: Tx, actor: Actor): Promise<number[]> {
  if (!actor.staffId) return [];
  const rows = await tx.select({ c: schema.staffAssignments.classId }).from(schema.staffAssignments).where(and(
    eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId),
    eq(schema.staffAssignments.assignmentType, 'class_teacher'), eq(schema.staffAssignments.status, 'active')));
  return rows.map((r) => Number(r.c)).filter(Boolean);
}

async function requireEditClass(tx: Tx, actor: Actor, classId: number) {
  const [cls] = await tx.select({ id: schema.classes.id }).from(schema.classes).where(and(eq(schema.classes.id, classId), eq(schema.classes.schoolId, actor.schoolId))).limit(1);
  if (!cls) throw new CalendarError('That class was not found.');
  if (!canEditClassTimetable(actor.role, classId, await classTeacherClasses(tx, actor))) throw new CalendarError('You can only set the timetable of the class you are class teacher of.');
}

/** Replace the school's bell schedule. Lessons in a period that is removed go with it, so a change that would do that is refused unless confirmed. */
export async function savePeriods(actor: Actor, input: Array<{ name: string; startTime: string; endTime: string; isBreak?: boolean }>, confirmRemoveLessons = false): Promise<{ ok: true } | { ok: false; errors: string[]; lessonsAffected?: number }> {
  if (!canEditPeriods(actor.role)) throw new CalendarError('Only the principal, vice principal or exam officer can change the school\'s periods.');
  const clean = input.map((p) => ({ name: String(p.name ?? '').trim().slice(0, 60), startTime: String(p.startTime ?? ''), endTime: String(p.endTime ?? ''), isBreak: !!p.isBreak }));
  const errors = periodsProblems(clean);
  if (errors.length) return { ok: false, errors };
  const ordered = [...clean].sort((a, b) => a.startTime.localeCompare(b.startTime));

  return forSchool(actor.schoolId, async (tx) => {
    const existing = await periodsOf(tx, actor.schoolId);
    // Periods are matched by name, so renaming or re-timing one keeps its lessons; only a period that disappears loses them.
    const keep = new Map(ordered.map((p, i) => [p.name.toLowerCase(), i]));
    const gone = existing.filter((p) => !keep.has(p.name.toLowerCase()));
    if (gone.length) {
      const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.timetableLessons).where(and(eq(schema.timetableLessons.schoolId, actor.schoolId), inArray(schema.timetableLessons.periodId, gone.map((g) => g.id))));
      const n = counted?.n ?? 0;
      if (n > 0 && !confirmRemoveLessons) return { ok: false as const, errors: [`Removing ${gone.map((g) => `"${g.name}"`).join(', ')} would delete ${n} lesson${n === 1 ? '' : 's'} placed in it. Move them first, or confirm the removal.`], lessonsAffected: n };
    }
    // Two passes avoid tripping the unique position index mid-way.
    const byName = new Map(existing.map((p) => [p.name.toLowerCase(), p]));
    for (const p of existing) await tx.update(schema.timetablePeriods).set({ position: -Number(p.id) }).where(eq(schema.timetablePeriods.id, p.id));
    for (const p of gone) await tx.delete(schema.timetablePeriods).where(eq(schema.timetablePeriods.id, p.id));
    for (let i = 0; i < ordered.length; i++) {
      const p = ordered[i]!, found = byName.get(p.name.toLowerCase());
      if (found) await tx.update(schema.timetablePeriods).set({ name: p.name, position: i + 1, startTime: p.startTime, endTime: p.endTime, isBreak: p.isBreak }).where(eq(schema.timetablePeriods.id, found.id));
      else await tx.insert(schema.timetablePeriods).values({ schoolId: actor.schoolId, name: p.name, position: i + 1, startTime: p.startTime, endTime: p.endTime, isBreak: p.isBreak });
    }
    await audit(tx, actor, 'timetable.periods_saved', 'timetable_periods', null, existing.map((p) => ({ name: p.name, start: p.startTime, end: p.endTime })), ordered.map((p) => ({ name: p.name, start: p.startTime, end: p.endTime, break: p.isBreak })));
    return { ok: true as const };
  });
}

export type ClassOption = { id: number; name: string; canEdit: boolean };
export type LessonView = LessonRow & { subjectName: string; staffName: string; room: string };

export type TimetableView = {
  periods: Period[]; classes: ClassOption[]; classId: number | null; className: string; lessons: LessonView[];
  published: boolean; canEdit: boolean; canEditPeriods: boolean;
  /** Subjects this class has, each with the teachers assigned to it here: the only valid choices for a lesson. */
  choices: Array<{ subjectId: number; subjectName: string; teachers: Array<{ staffId: number; name: string }> }>;
  todaysLessons: LessonView[]; today: string; teachingToday: boolean;
};

/** The classes a person may OPEN: everything for a manager; for a teacher the classes they teach or head; for a student or parent only theirs. */
async function openableClassIds(tx: Tx, actor: Actor, sessionId: number): Promise<number[] | 'all'> {
  if (isManager(actor.role)) return 'all';
  const ids = new Set<number>();
  if (actor.role === 'teacher' && actor.staffId) {
    const rows = await tx.select({ c: schema.staffAssignments.classId }).from(schema.staffAssignments).where(and(eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId), eq(schema.staffAssignments.status, 'active')));
    rows.forEach((r) => r.c && ids.add(Number(r.c)));
  } else if (actor.role === 'student' && actor.studentId) {
    const rows = await tx.select({ c: schema.enrollments.classId }).from(schema.enrollments).where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.studentId, actor.studentId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
    rows.forEach((r) => ids.add(Number(r.c)));
  } else if (actor.role === 'parent') {
    const rows = await tx.select({ c: schema.enrollments.classId }).from(schema.guardians).innerJoin(schema.guardianStudent, eq(schema.guardianStudent.guardianId, schema.guardians.id)).innerJoin(schema.enrollments, eq(schema.enrollments.studentId, schema.guardianStudent.studentId)).where(and(eq(schema.guardians.userId, actor.userId), eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
    rows.forEach((r) => ids.add(Number(r.c)));
  }
  return [...ids];
}

export async function loadTimetable(actor: Actor, sessionId?: number, wantedClassId?: number): Promise<TimetableView> {
  return forSchool(actor.schoolId, async (tx) => {
    const sessions = await listSessions(tx, actor.schoolId);
    const session = sessions.find((s) => s.id === sessionId) ?? sessions.find((s) => s.isCurrent) ?? sessions[0];
    const periods = await periodsOf(tx, actor.schoolId);
    const tz = await schoolTimeZone(tx, actor.schoolId), today = todayIn(tz);
    const empty: TimetableView = { periods, classes: [], classId: null, className: '', lessons: [], published: false, canEdit: false, canEditPeriods: canEditPeriods(actor.role), choices: [], todaysLessons: [], today, teachingToday: false };
    if (!session) return empty;

    const open = await openableClassIds(tx, actor, session.id), mine = await classTeacherClasses(tx, actor);
    const all = await tx.select({ id: schema.classes.id, name: schema.classes.displayName }).from(schema.classes).where(eq(schema.classes.schoolId, actor.schoolId)).orderBy(asc(schema.classes.displayName));
    const visible = all.filter((c) => open === 'all' || open.includes(Number(c.id)));
    const classes = visible.map((c) => ({ id: Number(c.id), name: c.name, canEdit: canEditClassTimetable(actor.role, Number(c.id), mine) }));
    // A request for a class the person may not open falls back to their first one; it never reveals the other.
    const chosen = classes.find((c) => c.id === wantedClassId) ?? classes[0];
    if (!chosen) return { ...empty, classes };

    const [pub] = await tx.select().from(schema.timetablePublication).where(and(eq(schema.timetablePublication.schoolId, actor.schoolId), eq(schema.timetablePublication.sessionId, session.id), eq(schema.timetablePublication.classId, chosen.id))).limit(1);
    const editor = chosen.canEdit;
    // Students and parents see a timetable only once it is published; staff see the working draft of the classes they can open.
    if (!editor && ['student', 'parent'].includes(actor.role) && !pub) return { ...empty, classes, classId: chosen.id, className: chosen.name };

    const rows = await tx.select({ l: schema.timetableLessons, subject: schema.subjects.name, first: schema.staff.firstName, last: schema.staff.lastName })
      .from(schema.timetableLessons).innerJoin(schema.subjects, eq(schema.subjects.id, schema.timetableLessons.subjectId)).leftJoin(schema.staff, eq(schema.staff.id, schema.timetableLessons.staffId))
      .where(and(eq(schema.timetableLessons.schoolId, actor.schoolId), eq(schema.timetableLessons.sessionId, session.id), eq(schema.timetableLessons.classId, chosen.id)));
    const lessons: LessonView[] = rows.map((r) => ({ id: Number(r.l.id), classId: Number(r.l.classId), periodId: Number(r.l.periodId), weekday: r.l.weekday, subjectId: Number(r.l.subjectId), staffId: r.l.staffId ? Number(r.l.staffId) : null, subjectName: r.subject, staffName: r.first ? `${r.first} ${r.last ?? ''}`.trim() : '', room: r.l.room }));

    let choices: TimetableView['choices'] = [];
    if (editor) {
      const a = await tx.select({ subjectId: schema.staffAssignments.subjectId, subject: schema.subjects.name, staffId: schema.staff.id, first: schema.staff.firstName, last: schema.staff.lastName })
        .from(schema.staffAssignments).innerJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId)).innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
        .where(and(eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.classId, chosen.id), eq(schema.staffAssignments.assignmentType, 'subject_teacher'), eq(schema.staffAssignments.status, 'active')));
      const m = new Map<number, { subjectId: number; subjectName: string; teachers: Array<{ staffId: number; name: string }> }>();
      for (const r of a) { const k = Number(r.subjectId); const e = m.get(k) ?? { subjectId: k, subjectName: r.subject, teachers: [] }; e.teachers.push({ staffId: Number(r.staffId), name: `${r.first} ${r.last ?? ''}`.trim() }); m.set(k, e); }
      choices = [...m.values()].sort((x, y) => x.subjectName.localeCompare(y.subjectName));
    }

    // Today's lessons honour the academic calendar: a holiday or break empties the day.
    const terms = await termsOf(tx, actor.schoolId, session.id);
    const evRows = await tx.select().from(schema.calendarEvents).where(and(eq(schema.calendarEvents.schoolId, actor.schoolId), eq(schema.calendarEvents.sessionId, session.id), inArray(schema.calendarEvents.category, ['public_holiday', 'school_holiday'])));
    const holidays: CalEvent[] = evRows.filter((e) => e.status !== 'cancelled' && e.published).map((e) => ({ key: `e${e.id}`, id: Number(e.id), source: 'event', title: e.title, category: e.category, status: e.status, startsOn: e.startsOn, endsOn: e.endsOn, startTime: null, endTime: null, allDay: true, venue: '', description: '', audience: e.audience, classIds: [], published: true, repeat: 'none', repeatEvery: 1, repeatUntil: null }));
    const teaching = instructionalDays(terms, holidays);
    const wd = new Date(`${today}T00:00:00Z`).getUTCDay(), tw = wd === 0 ? 7 : wd;
    const teachingToday = teaching.has(today);
    return { periods, classes, classId: chosen.id, className: chosen.name, lessons, published: !!pub, canEdit: editor, canEditPeriods: canEditPeriods(actor.role), choices, todaysLessons: teachingToday ? lessons.filter((l) => l.weekday === tw) : [], today, teachingToday };
  });
}

export type LessonInput = { classId: number; periodId: number; weekday: number; subjectId: number; staffId?: number | null; room?: string };
export type LessonResult = { ok: true; id: number } | { ok: false; errors: string[] };

/** Add or move a lesson into a slot. `id` given = edit that lesson. */
export async function saveLesson(actor: Actor, sessionId: number, input: LessonInput, id?: number): Promise<LessonResult> {
  return forSchool(actor.schoolId, async (tx) => {
    const [session] = await tx.select({ id: schema.academicSessions.id }).from(schema.academicSessions).where(and(eq(schema.academicSessions.id, sessionId), eq(schema.academicSessions.schoolId, actor.schoolId))).limit(1);
    if (!session) throw new CalendarError('That academic session was not found.');
    await requireEditClass(tx, actor, input.classId);

    const [period] = await tx.select().from(schema.timetablePeriods).where(and(eq(schema.timetablePeriods.id, input.periodId), eq(schema.timetablePeriods.schoolId, actor.schoolId))).limit(1);
    if (!period) return { ok: false as const, errors: ['That period was not found.'] };
    const [subject] = await tx.select({ id: schema.subjects.id }).from(schema.subjects).where(and(eq(schema.subjects.id, input.subjectId), eq(schema.subjects.schoolId, actor.schoolId))).limit(1);
    if (!subject) return { ok: false as const, errors: ['That subject was not found.'] };

    const taught = await tx.select({ staffId: schema.staffAssignments.staffId }).from(schema.staffAssignments).where(and(eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.classId, input.classId), eq(schema.staffAssignments.subjectId, input.subjectId), eq(schema.staffAssignments.assignmentType, 'subject_teacher'), eq(schema.staffAssignments.status, 'active')));
    const staffId = input.staffId ? Number(input.staffId) : null;

    const sameClassSlot = await tx.select({ id: schema.timetableLessons.id }).from(schema.timetableLessons).where(and(eq(schema.timetableLessons.sessionId, sessionId), eq(schema.timetableLessons.classId, input.classId), eq(schema.timetableLessons.weekday, input.weekday), eq(schema.timetableLessons.periodId, input.periodId), ...(id ? [ne(schema.timetableLessons.id, id)] : [])));
    let busy: string | null = null;
    if (staffId) {
      const [other] = await tx.select({ cls: schema.classes.displayName }).from(schema.timetableLessons).innerJoin(schema.classes, eq(schema.classes.id, schema.timetableLessons.classId)).where(and(eq(schema.timetableLessons.sessionId, sessionId), eq(schema.timetableLessons.staffId, staffId), eq(schema.timetableLessons.weekday, input.weekday), eq(schema.timetableLessons.periodId, input.periodId), ...(id ? [ne(schema.timetableLessons.id, id)] : []))).limit(1);
      busy = other?.cls ?? null;
    }
    const errors = lessonProblems({ periodIsBreak: period.isBreak, weekday: input.weekday, subjectTaughtInClass: taught.length > 0, teacherAssigned: staffId ? taught.some((t) => Number(t.staffId) === staffId) : null, classSlotTaken: sameClassSlot.length > 0, teacherBusyWith: busy });
    if (errors.length) return { ok: false as const, errors };

    const values = { weekday: input.weekday, periodId: input.periodId, subjectId: input.subjectId, staffId, room: String(input.room ?? '').trim().slice(0, 60), updatedAt: new Date() };
    try {
      let lessonId: number, before: unknown = null;
      if (id) {
        const [row] = await tx.select().from(schema.timetableLessons).where(and(eq(schema.timetableLessons.id, id), eq(schema.timetableLessons.schoolId, actor.schoolId), eq(schema.timetableLessons.classId, input.classId))).limit(1);
        if (!row) throw new CalendarError('That lesson was not found in this class.');
        before = { weekday: row.weekday, periodId: Number(row.periodId), subjectId: Number(row.subjectId), staffId: row.staffId ? Number(row.staffId) : null };
        await tx.update(schema.timetableLessons).set(values).where(eq(schema.timetableLessons.id, id)); lessonId = id;
      } else {
        const [ins] = await tx.insert(schema.timetableLessons).values({ ...values, schoolId: actor.schoolId, sessionId, classId: input.classId, createdBy: actor.userId }).returning({ id: schema.timetableLessons.id }); lessonId = Number(ins!.id);
      }
      await audit(tx, actor, id ? 'timetable.lesson_updated' : 'timetable.lesson_added', 'timetable_lessons', lessonId, before, { classId: input.classId, ...values, updatedAt: undefined });
      return { ok: true as const, id: lessonId };
    } catch (e) {
      // Two people saved the same slot at the same instant: the unique index decided; say so in plain words.
      if (e instanceof Error && /timetable_lessons_(class|teacher)_slot_uq|duplicate key/.test(e.message + String((e as { cause?: unknown }).cause ?? ''))) return { ok: false as const, errors: ['Someone else just filled that slot. Refresh to see the latest timetable.'] };
      throw e;
    }
  });
}

export async function removeLesson(actor: Actor, lessonId: number): Promise<void> {
  await forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx.select().from(schema.timetableLessons).where(and(eq(schema.timetableLessons.id, lessonId), eq(schema.timetableLessons.schoolId, actor.schoolId))).limit(1);
    if (!row) throw new CalendarError('That lesson was not found.');
    await requireEditClass(tx, actor, Number(row.classId));
    await tx.delete(schema.timetableLessons).where(eq(schema.timetableLessons.id, lessonId));
    await audit(tx, actor, 'timetable.lesson_removed', 'timetable_lessons', lessonId, { classId: Number(row.classId), weekday: row.weekday, periodId: Number(row.periodId), subjectId: Number(row.subjectId) }, null);
  });
}

/** Publish a class's timetable to its students and parents, or take it back to a draft. */
export async function setTimetablePublished(actor: Actor, sessionId: number, classId: number, publish: boolean): Promise<{ notified: number }> {
  return forSchool(actor.schoolId, async (tx) => {
    const [session] = await tx.select({ id: schema.academicSessions.id }).from(schema.academicSessions).where(and(eq(schema.academicSessions.id, sessionId), eq(schema.academicSessions.schoolId, actor.schoolId))).limit(1);
    if (!session) throw new CalendarError('That academic session was not found.');
    await requireEditClass(tx, actor, classId);
    const [was] = await tx.select().from(schema.timetablePublication).where(and(eq(schema.timetablePublication.sessionId, sessionId), eq(schema.timetablePublication.classId, classId))).limit(1);
    let notified = 0;
    if (publish) {
      const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.timetableLessons).where(and(eq(schema.timetableLessons.sessionId, sessionId), eq(schema.timetableLessons.classId, classId)));
      if (!counted || counted.n === 0) throw new CalendarError('Add at least one lesson before publishing the timetable.');
      if (!was) {
        await tx.insert(schema.timetablePublication).values({ schoolId: actor.schoolId, sessionId, classId, publishedBy: actor.userId });
        const [cls] = await tx.select({ name: schema.classes.displayName }).from(schema.classes).where(eq(schema.classes.id, classId)).limit(1);
        const students = await tx.select({ userId: schema.students.userId }).from(schema.enrollments).innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId)).where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, classId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
        const parents = await tx.select({ userId: schema.guardians.userId }).from(schema.enrollments).innerJoin(schema.guardianStudent, eq(schema.guardianStudent.studentId, schema.enrollments.studentId)).innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId)).where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, classId), eq(schema.enrollments.sessionId, sessionId), eq(schema.enrollments.status, 'active')));
        const ids = [...new Set([...students, ...parents].map((u) => Number(u.userId)).filter((n) => n > 0))];
        notified = await notifyMany(tx, actor.schoolId, ids.map((userId) => ({ userId, type: 'calendar_event' as const, title: `${cls?.name ?? 'Class'} timetable is ready`, body: 'See the weekly teaching timetable.', link: '/portal/calendar/timetable' })));
      }
    } else if (was) {
      await tx.delete(schema.timetablePublication).where(and(eq(schema.timetablePublication.sessionId, sessionId), eq(schema.timetablePublication.classId, classId)));
    }
    await audit(tx, actor, publish ? 'timetable.published' : 'timetable.unpublished', 'timetable_publication', classId, { published: !!was }, { published: publish });
    return { notified };
  });
}

/** A teacher's own teaching week across every class, read-only. */
export async function myTeachingWeek(actor: Actor, sessionId?: number): Promise<{ periods: Period[]; lessons: Array<LessonView & { className: string }> }> {
  return forSchool(actor.schoolId, async (tx) => {
    const sessions = await listSessions(tx, actor.schoolId);
    const session = sessions.find((s) => s.id === sessionId) ?? sessions.find((s) => s.isCurrent) ?? sessions[0];
    const periods = await periodsOf(tx, actor.schoolId);
    if (!session || !actor.staffId) return { periods, lessons: [] };
    const rows = await tx.select({ l: schema.timetableLessons, subject: schema.subjects.name, cls: schema.classes.displayName })
      .from(schema.timetableLessons).innerJoin(schema.subjects, eq(schema.subjects.id, schema.timetableLessons.subjectId)).innerJoin(schema.classes, eq(schema.classes.id, schema.timetableLessons.classId))
      .where(and(eq(schema.timetableLessons.schoolId, actor.schoolId), eq(schema.timetableLessons.sessionId, session.id), eq(schema.timetableLessons.staffId, actor.staffId)));
    return { periods, lessons: rows.map((r) => ({ id: Number(r.l.id), classId: Number(r.l.classId), periodId: Number(r.l.periodId), weekday: r.l.weekday, subjectId: Number(r.l.subjectId), staffId: actor.staffId, subjectName: r.subject, staffName: '', room: r.l.room, className: r.cls })) };
  });
}
