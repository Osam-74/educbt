/**
 * Class teaching timetable: who may edit which class, and the rules a lesson must satisfy.
 * Pure (no database) so every rule is pinned by tests. The service calls these on every save.
 *
 * The split you asked for:
 *   - the CLASS TEACHER sets the timetable of THEIR class, and nothing else;
 *   - the principal, vice principal and exam officer can set any class's timetable;
 *   - every other teacher can only see their own teaching week.
 */
import { isManager } from './access';

export type Slot = { classId: number; periodId: number; weekday: number };

export type Period = { id: number; name: string; position: number; startTime: string; endTime: string; isBreak: boolean };

/** classTeacherOf: the classes where this person holds an active class_teacher assignment. */
export function canEditClassTimetable(role: string, classId: number, classTeacherOf: number[]): boolean {
  if (isManager(role)) return true;
  return role === 'teacher' && classTeacherOf.includes(classId);
}

/** Only the people who run the school's academic calendar define its bell schedule: it affects every class. */
export const canEditPeriods = (role: string): boolean => isManager(role);

export type LessonCheck = {
  periodIsBreak: boolean;
  weekday: number;
  /** Is the subject one this class has (someone is assigned to teach it here)? */
  subjectTaughtInClass: boolean;
  /** When a teacher is chosen: do they hold an active assignment for THIS subject in THIS class? */
  teacherAssigned: boolean | null;
  /** Another lesson already holds this class's slot (excluding the lesson being edited). */
  classSlotTaken: boolean;
  /** The chosen teacher is already teaching another class in this slot. */
  teacherBusyWith: string | null;
};

export function lessonProblems(c: LessonCheck): string[] {
  const out: string[] = [];
  if (!Number.isInteger(c.weekday) || c.weekday < 1 || c.weekday > 7) out.push('Choose a day of the week.');
  if (c.periodIsBreak) out.push('That period is a break, so no lesson can be placed in it.');
  if (!c.subjectTaughtInClass) out.push('That subject is not taught in this class. Assign a teacher to it first.');
  if (c.teacherAssigned === false) out.push('That teacher is not assigned to this subject in this class.');
  if (c.classSlotTaken) out.push('This class already has a lesson in that period. Remove it first or choose another slot.');
  if (c.teacherBusyWith) out.push(`That teacher is already teaching ${c.teacherBusyWith} in that period.`);
  return out;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A bell schedule must be a sensible day: valid times, in order, no two periods overlapping. */
export function periodsProblems(periods: Array<{ name: string; startTime: string; endTime: string }>): string[] {
  const out: string[] = [];
  if (periods.length === 0) return ['Add at least one period.'];
  if (periods.length > 20) out.push('A school day cannot have more than 20 periods.');
  periods.forEach((p, i) => {
    const n = i + 1;
    if (!p.name.trim()) out.push(`Period ${n} needs a name.`);
    if (!TIME.test(p.startTime) || !TIME.test(p.endTime)) out.push(`Period ${n} needs valid times, such as 08:00 and 08:40.`);
    else if (p.endTime <= p.startTime) out.push(`Period ${n} must end after it starts.`);
  });
  if (!out.length) {
    const sorted = [...periods].sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.startTime < sorted[i - 1]!.endTime) out.push(`"${sorted[i - 1]!.name}" and "${sorted[i]!.name}" overlap.`);
    }
    const names = periods.map((p) => p.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) out.push('Two periods have the same name.');
  }
  return out;
}

export const WEEKDAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** JS weekday (0 = Sunday) to the timetable's (1 = Monday ... 7 = Sunday). */
export const timetableWeekday = (jsWeekday: number): number => (jsWeekday === 0 ? 7 : jsWeekday);

export type LessonRow = { id: number; classId: number; periodId: number; weekday: number; subjectId: number; staffId: number | null };

/**
 * The lessons that really happen on a given date: none on a weekend (unless the
 * school teaches on it), none on a holiday or outside term. `teachingDays` is the
 * set of instructional dates from the calendar engine, so a public holiday or
 * mid-term break empties that day automatically.
 */
export function lessonsOn(date: string, jsWeekday: number, lessons: LessonRow[], teachingDays: Set<string>): LessonRow[] {
  if (!teachingDays.has(date)) return [];
  const wd = timetableWeekday(jsWeekday);
  return lessons.filter((l) => l.weekday === wd);
}

/** Subjects a teacher teaches in a week, to spot an overloaded day. */
export function dayLoad(lessons: LessonRow[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const l of lessons) out[l.weekday] = (out[l.weekday] ?? 0) + 1;
  return out;
}
