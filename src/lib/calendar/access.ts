/**
 * Who may do what with the calendar, and who sees which event.
 *
 * Pure and database-free so the rules are pinned by tests and cannot quietly
 * widen. The rule of thumb: a page hides things for tidiness, THIS file is
 * what actually decides, and the server action calls it every time.
 */
import type { CalEvent } from './engine';

export type Viewer = {
  role: string;
  /** Classes the viewer teaches (teacher), is enrolled in (student) or whose children are in (parent). */
  classIds: number[];
};

/** Create, edit, publish and archive. The principal, vice principal and exam office: the same people who run the timetable. */
export const CALENDAR_MANAGERS = ['principal', 'vice_principal', 'exam_officer'] as const;
export const isManager = (role: string): boolean => (CALENDAR_MANAGERS as readonly string[]).includes(role);

/** Publishing and archiving the whole calendar, and overriding a warning, is for the leadership only. */
export const CALENDAR_PUBLISHERS = ['principal', 'vice_principal'] as const;
export const canPublish = (role: string): boolean => (CALENDAR_PUBLISHERS as readonly string[]).includes(role);

const STAFF = ['principal', 'vice_principal', 'exam_officer', 'teacher'];

/**
 * Can this viewer see this event at all?
 *  - managers see everything, including drafts and unpublished events;
 *  - everyone else sees only published, non-draft events, and only when the
 *    calendar itself is published;
 *  - then the audience narrows it: staff-only events stay with staff, class
 *    events go to the people connected to those classes.
 */
export function canSee(ev: Pick<CalEvent, 'status' | 'published' | 'audience' | 'classIds'>, v: Viewer, calendarPublished: boolean): boolean {
  if (isManager(v.role)) return true;
  if (!calendarPublished || !ev.published || ev.status === 'draft') return false;

  switch (ev.audience) {
    case 'everyone': return true;
    case 'staff': return STAFF.includes(v.role);
    case 'teachers': return v.role === 'teacher';
    case 'students': return v.role === 'student';
    case 'guardians': return v.role === 'parent';
    case 'classes':
      // A teacher sees the classes they teach; a student or parent only their own (or their children's).
      return v.classIds.some((c) => ev.classIds.includes(c));
    default: return false;
  }
}

export const filterVisible = <T extends Pick<CalEvent, 'status' | 'published' | 'audience' | 'classIds'>>(
  events: T[], v: Viewer, calendarPublished: boolean,
): T[] => events.filter((e) => canSee(e, v, calendarPublished));

/**
 * Examinations come from the exam records and are shown to people the exam
 * timetable is already shown to. A series that is not yet published to
 * teachers and parents stays with the exam office, exactly as on the timetable page.
 */
export function canSeeExam(seriesStatus: string, v: Viewer, classIds: number[]): boolean {
  if (isManager(v.role)) return true;
  if (!['published', 'closed'].includes(seriesStatus)) return false;
  if (v.role === 'teacher') return true;
  return classIds.length === 0 ? true : v.classIds.some((c) => classIds.includes(c));
}
