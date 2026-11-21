/**
 * The calendar's brain: occurrences, instructional days and weeks, and conflicts.
 * Pure (no database, no clock unless one is passed in), so every rule here is
 * pinned by tests/calendar.test.ts.
 */
import {
  type DateStr, addDays, addMonths, cmp, diffDays, eachDay, isWeekend, maxDate, minDate, overlaps, startOfWeek,
} from './dates';

export type Category =
  | 'academic' | 'examination' | 'school_event' | 'public_holiday'
  | 'school_holiday' | 'mid_term_break' | 'non_instructional' | 'administrative' | 'deadline' | 'ceremonial';

/**
 * The categories that take a day OFF teaching. ONE list, used by instructional days, conflicts and the timetable, so a
 * new kind of break can never be honoured in one place and forgotten in another. A special event (school_event) does not
 * shade a date: it happens on a school day.
 */
export const NON_INSTRUCTIONAL: readonly Category[] = ['public_holiday', 'school_holiday', 'mid_term_break', 'non_instructional'];
export const isNonInstructional = (c: Category): boolean => NON_INSTRUCTIONAL.includes(c);

export type CalEvent = {
  /** 'e12' for a stored event, 'x7' for an examination read from the exam records. */
  key: string;
  id: number;
  source: 'event' | 'exam';
  title: string;
  category: Category;
  status: 'draft' | 'scheduled' | 'completed' | 'cancelled';
  startsOn: DateStr;
  endsOn: DateStr;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
  venue: string;
  description: string;
  audience: string;
  classIds: number[];
  published: boolean;
  repeat: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
  repeatEvery: number;
  repeatUntil: DateStr | null;
  /** Where an exam is managed. Set only for source 'exam': such an entry is read-only here. */
  manageHref?: string;
  overridden?: boolean;
};

export type Term = { id: number; title: string; position: number; startsOn: DateStr | null; endsOn: DateStr | null };

/** Never expand more than this many occurrences of one event: a daily event "forever" must not hang a page. */
export const MAX_OCCURRENCES = 800;

/**
 * Every occurrence of an event that touches [from, to]. A multi-day event keeps
 * its length in every occurrence. An event with no end date repeats to the end of the window asked for.
 */
export function occurrences(ev: CalEvent, from: DateStr, to: DateStr): CalEvent[] {
  const span = diffDays(ev.startsOn, ev.endsOn);
  const hits = (s: DateStr) => overlaps(s, addDays(s, span), from, to);
  if (ev.repeat === 'none') return hits(ev.startsOn) ? [ev] : [];

  const every = Math.max(1, ev.repeatEvery);
  const last = ev.repeatUntil ? minDate(ev.repeatUntil, to) : to;
  const out: CalEvent[] = [];
  let i = 0;
  for (; i < MAX_OCCURRENCES * 3; i++) {
    const start = ev.repeat === 'daily' ? addDays(ev.startsOn, i * every)
      : ev.repeat === 'weekly' ? addDays(ev.startsOn, i * every * 7)
      : ev.repeat === 'monthly' ? addMonths(ev.startsOn, i * every)
      : addMonths(ev.startsOn, i * every * 12);
    if (cmp(start, last) > 0) break;
    if (hits(start)) {
      out.push({ ...ev, startsOn: start, endsOn: addDays(start, span), key: `${ev.key}@${start}` });
      if (out.length >= MAX_OCCURRENCES) break;
    }
  }
  return out;
}

// ── Terms and academic periods ───────────────────────────────────────────

export type Period = {
  kind: 'term' | 'vacation' | 'examination';
  label: string;
  startsOn: DateStr;
  endsOn: DateStr;
  termId?: number;
};

/** Terms in order, with the vacation between one term's close and the next one's resumption. */
export function buildPeriods(terms: Term[], examWindows: Array<{ title: string; startsOn: DateStr; endsOn: DateStr }>): Period[] {
  const dated = terms.filter((t): t is Term & { startsOn: DateStr; endsOn: DateStr } => !!t.startsOn && !!t.endsOn)
    .sort((a, b) => cmp(a.startsOn, b.startsOn));
  const out: Period[] = [];
  dated.forEach((t, i) => {
    out.push({ kind: 'term', label: t.title, startsOn: t.startsOn, endsOn: t.endsOn, termId: t.id });
    const next = dated[i + 1];
    if (next && diffDays(t.endsOn, next.startsOn) > 1) {
      out.push({ kind: 'vacation', label: `Vacation after ${t.title}`, startsOn: addDays(t.endsOn, 1), endsOn: addDays(next.startsOn, -1) });
    }
  });
  for (const w of examWindows) out.push({ kind: 'examination', label: w.title, startsOn: w.startsOn, endsOn: w.endsOn });
  return out.sort((a, b) => cmp(a.startsOn, b.startsOn) || (a.kind === 'term' ? -1 : 1));
}

export type PeriodState = 'completed' | 'ongoing' | 'upcoming';
export const stateOf = (startsOn: DateStr, endsOn: DateStr, today: DateStr): PeriodState =>
  cmp(endsOn, today) < 0 ? 'completed' : cmp(startsOn, today) > 0 ? 'upcoming' : 'ongoing';

// ── Instructional days and weeks ─────────────────────────────────────────

/**
 * A day is instructional when it is inside a term, is not a weekend, and is not
 * covered by a holiday. A holiday inside a term (a mid-term break, a public
 * holiday) removes its days; a holiday outside any term changes nothing.
 */
export function instructionalDays(terms: Term[], events: CalEvent[]): Set<DateStr> {
  const off = new Set<DateStr>();
  for (const e of events) {
    if (e.status === 'cancelled') continue;
    if (!isNonInstructional(e.category)) continue;
    for (const d of eachDay(e.startsOn, e.endsOn)) off.add(d);
  }
  const days = new Set<DateStr>();
  for (const t of terms) {
    if (!t.startsOn || !t.endsOn) continue;
    for (const d of eachDay(t.startsOn, t.endsOn)) if (!isWeekend(d) && !off.has(d)) days.add(d);
  }
  return days;
}

/**
 * What a date is BEFORE anyone overrides it, worked out from the term dates alone (nothing is stored, so changing a
 * term's dates changes every day at once). Monday to Friday inside a term is a school day, Saturday and Sunday inside a
 * term are a weekend, and a date outside every term has no default at all.
 */
export type DefaultStatus = 'school_day' | 'weekend' | 'none';
export function defaultStatus(date: DateStr, terms: Term[]): DefaultStatus {
  for (const t of terms) {
    if (!t.startsOn || !t.endsOn) continue;
    if (cmp(date, t.startsOn) < 0 || cmp(date, t.endsOn) > 0) continue;
    return isWeekend(date) ? 'weekend' : 'school_day';
  }
  return 'none';
}

/**
 * What a date really is once the school's own entries are applied: the default, unless a holiday, break or
 * non-instructional entry covers it (then it is `off`, and `by` names the entry, so the office can undo it by cancelling
 * that entry: "restore default"). A weekend or a date outside any term stays as it is: a holiday there changes nothing.
 */
export type DayStatus = { state: 'school_day' | 'weekend' | 'off' | 'none'; default: DefaultStatus; by: CalEvent | null };
export function dayStatus(date: DateStr, terms: Term[], events: CalEvent[]): DayStatus {
  const def = defaultStatus(date, terms);
  if (def !== 'school_day') return { state: def, default: def, by: null };
  const by = events.find((e) => e.status !== 'cancelled' && isNonInstructional(e.category) && cmp(date, e.startsOn) >= 0 && cmp(date, e.endsOn) <= 0) ?? null;
  return by ? { state: 'off', default: def, by } : { state: 'school_day', default: def, by: null };
}

export type Progress = {
  totalDays: number; doneDays: number; remainingDays: number;
  totalWeeks: number; doneWeeks: number; remainingWeeks: number;
  /** 1-based week of the CURRENT term (0 when school is not in session). */
  currentWeek: number;
  /** 0 to 100, from instructional days. */
  percent: number;
};

/** A week counts when it holds at least one instructional day. Weeks are Monday to Sunday. */
export function progress(terms: Term[], events: CalEvent[], today: DateStr): Progress {
  const days = [...instructionalDays(terms, events)].sort();
  const weeks = new Map<DateStr, boolean>(); // week start -> finished
  for (const d of days) weeks.set(startOfWeek(d), false);
  const doneDays = days.filter((d) => cmp(d, today) < 0).length;
  const thisWeek = startOfWeek(today);
  let doneWeeks = 0;
  for (const w of weeks.keys()) if (cmp(w, thisWeek) < 0) doneWeeks++;
  const totalDays = days.length;

  let currentWeek = 0;
  const cur = terms.find((t) => t.startsOn && t.endsOn && cmp(t.startsOn, today) <= 0 && cmp(today, t.endsOn) <= 0);
  if (cur?.startsOn) {
    const termDays = days.filter((d) => cmp(d, cur.startsOn!) >= 0 && cmp(d, cur.endsOn!) <= 0);
    const termWeeks = [...new Set(termDays.map(startOfWeek))].sort();
    const idx = termWeeks.indexOf(thisWeek);
    currentWeek = idx >= 0 ? idx + 1 : termWeeks.filter((w) => cmp(w, thisWeek) < 0).length;
  }
  return {
    totalDays, doneDays, remainingDays: totalDays - doneDays,
    totalWeeks: weeks.size, doneWeeks, remainingWeeks: weeks.size - doneWeeks,
    currentWeek,
    percent: totalDays ? Math.round((doneDays / totalDays) * 100) : 0,
  };
}

/** The first term that starts after today, and how many days away it is. */
export function nextResumption(terms: Term[], today: DateStr): { title: string; on: DateStr; inDays: number } | null {
  const next = terms.filter((t): t is Term & { startsOn: DateStr } => !!t.startsOn && cmp(t.startsOn, today) > 0).sort((a, b) => cmp(a.startsOn, b.startsOn))[0];
  return next ? { title: next.title, on: next.startsOn, inDays: diffDays(today, next.startsOn) } : null;
}

/** Days until the next examination that has not finished, or 0 if one is on today; null when none is planned. */
export function daysToNextExam(events: CalEvent[], today: DateStr): { title: string; on: DateStr; inDays: number } | null {
  const exams = events.filter((e) => e.category === 'examination' && e.status !== 'cancelled' && cmp(e.endsOn, today) >= 0)
    .sort((a, b) => cmp(a.startsOn, b.startsOn));
  const e = exams[0];
  return e ? { title: e.title, on: maxDate(e.startsOn, today), inDays: Math.max(0, diffDays(today, e.startsOn)) } : null;
}

// ── Conflicts ────────────────────────────────────────────────────────────

export type Conflict = {
  kind: 'exam_in_holiday' | 'exam_outside_term' | 'event_outside_session' | 'overlap_major';
  severity: 'warning';
  message: string;
  withKey?: string;
};

const MAJOR: Category[] = ['examination', 'ceremonial', 'school_event'];

/**
 * What is questionable about this event. These are WARNINGS: a school may
 * legitimately hold an exam on a holiday (a make-up sitting), so nothing here
 * blocks saving. An authorised manager overrides, and the override is recorded.
 */
export function conflictsFor(
  ev: Pick<CalEvent, 'key' | 'category' | 'startsOn' | 'endsOn' | 'title' | 'status' | 'allDay' | 'startTime' | 'endTime' | 'classIds'>,
  ctx: { terms: Term[]; others: CalEvent[]; sessionStart: DateStr | null; sessionEnd: DateStr | null },
): Conflict[] {
  if (ev.status === 'cancelled' || ev.status === 'draft') return [];
  const out: Conflict[] = [];
  const holidays = ctx.others.filter((o) => o.key !== ev.key && o.status !== 'cancelled' && isNonInstructional(o.category));

  if (ev.category === 'examination') {
    const h = holidays.find((o) => overlaps(ev.startsOn, ev.endsOn, o.startsOn, o.endsOn));
    if (h) out.push({ kind: 'exam_in_holiday', severity: 'warning', message: `This examination falls on "${h.title}".`, withKey: h.key });
    const dated = ctx.terms.filter((t) => t.startsOn && t.endsOn);
    if (dated.length && !dated.some((t) => overlaps(ev.startsOn, ev.endsOn, t.startsOn!, t.endsOn!))) {
      out.push({ kind: 'exam_outside_term', severity: 'warning', message: 'This examination is not inside any term.' });
    }
  }
  if (ctx.sessionStart && ctx.sessionEnd && !overlaps(ev.startsOn, ev.endsOn, ctx.sessionStart, ctx.sessionEnd)) {
    out.push({ kind: 'event_outside_session', severity: 'warning', message: 'This is outside the academic session.' });
  }
  if (MAJOR.includes(ev.category)) {
    for (const o of ctx.others) {
      if (o.key === ev.key || o.status === 'cancelled' || o.status === 'draft' || !MAJOR.includes(o.category)) continue;
      if (!overlaps(ev.startsOn, ev.endsOn, o.startsOn, o.endsOn)) continue;
      if (!timesClash(ev, o)) continue;
      // Two exams for DIFFERENT classes on one day are normal. Two for the same class, or for the whole school, are not.
      if (ev.category === 'examination' && o.category === 'examination' && ev.classIds.length && o.classIds.length && !ev.classIds.some((c) => o.classIds.includes(c))) continue;
      out.push({ kind: 'overlap_major', severity: 'warning', message: `This overlaps "${o.title}".`, withKey: o.key });
    }
  }
  return out;
}

function timesClash(
  a: Pick<CalEvent, 'allDay' | 'startTime' | 'endTime' | 'startsOn' | 'endsOn'>,
  b: Pick<CalEvent, 'allDay' | 'startTime' | 'endTime' | 'startsOn' | 'endsOn'>,
): boolean {
  // Different times on a shared single day do not clash. Anything multi-day, or all-day, does.
  if (a.allDay || b.allDay || !a.startTime || !b.startTime) return true;
  if (a.startsOn !== a.endsOn || b.startsOn !== b.endsOn) return true;
  const aEnd = a.endTime ?? '23:59', bEnd = b.endTime ?? '23:59';
  return a.startTime < bEnd && b.startTime < aEnd;
}
