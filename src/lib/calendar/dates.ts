/**
 * Calendar-date arithmetic on plain 'YYYY-MM-DD' strings.
 *
 * Every function works in UTC on whole days, so the answer never depends on the
 * server's timezone and a date can never slip a day. A school's own timezone is
 * only needed to turn a stored instant (an exam's scheduled_at) into the date it
 * falls on locally: see toLocalDate.
 */

export type DateStr = string;

const MS_DAY = 86_400_000;
const RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateStr(s: unknown): s is DateStr {
  if (typeof s !== 'string') return false;
  const m = RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCFullYear() === +m[1]! && d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]!;
}

export function parse(s: DateStr): number {
  if (!isDateStr(s)) throw new Error(`Not a calendar date: ${String(s)}`);
  const m = RE.exec(s)!;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!);
}

export function fmt(ms: number): DateStr {
  const d = new Date(ms);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export const addDays = (s: DateStr, n: number): DateStr => fmt(parse(s) + n * MS_DAY);
export const diffDays = (a: DateStr, b: DateStr): number => Math.round((parse(b) - parse(a)) / MS_DAY);
export const cmp = (a: DateStr, b: DateStr): number => (a < b ? -1 : a > b ? 1 : 0);
export const maxDate = (a: DateStr, b: DateStr): DateStr => (a > b ? a : b);
export const minDate = (a: DateStr, b: DateStr): DateStr => (a < b ? a : b);

/** 0 = Sunday ... 6 = Saturday */
export const weekday = (s: DateStr): number => new Date(parse(s)).getUTCDay();
export const isWeekend = (s: DateStr): boolean => { const w = weekday(s); return w === 0 || w === 6; };

/** The Monday on or before this date. */
export function startOfWeek(s: DateStr): DateStr {
  const w = weekday(s);
  return addDays(s, -((w + 6) % 7));
}

export const startOfMonth = (s: DateStr): DateStr => `${s.slice(0, 7)}-01`;
export const daysInMonth = (year: number, month1: number): number => new Date(Date.UTC(year, month1, 0)).getUTCDate();
export const endOfMonth = (s: DateStr): DateStr => `${s.slice(0, 7)}-${String(daysInMonth(+s.slice(0, 4), +s.slice(5, 7))).padStart(2, '0')}`;

/** Add whole months, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb), never spilling into the next month. */
export function addMonths(s: DateStr, n: number): DateStr {
  const y = +s.slice(0, 4), m = +s.slice(5, 7) - 1, d = +s.slice(8, 10);
  const total = y * 12 + m + n;
  const ny = Math.floor(total / 12), nm = total - ny * 12;
  return fmt(Date.UTC(ny, nm, Math.min(d, daysInMonth(ny, nm + 1))));
}

/** Every date from a to b inclusive. Refuses absurd ranges so a typo cannot hang a page. */
export function eachDay(a: DateStr, b: DateStr, limit = 3700): DateStr[] {
  const n = diffDays(a, b);
  if (n < 0) return [];
  if (n + 1 > limit) throw new Error('That date range is too long.');
  const out: DateStr[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(a, i));
  return out;
}

/** True when the two inclusive ranges share at least one day. */
export const overlaps = (aS: DateStr, aE: DateStr, bS: DateStr, bE: DateStr): boolean => aS <= bE && bS <= aE;

/**
 * The calendar date an instant falls on in the SCHOOL's timezone.
 * An exam at 23:30 in Lagos (22:30 UTC) is on that Lagos day, not the UTC one.
 */
export function toLocalDate(instant: Date, timeZone: string): DateStr {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** The local clock time ('HH:MM') of an instant in the school's timezone. */
export function toLocalTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  return `${parts.find((p) => p.type === 'hour')!.value}:${parts.find((p) => p.type === 'minute')!.value}`;
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

/** The date in the school's timezone right now, which is what "today" means to the school. */
export const todayIn = (timeZone: string, now: Date = new Date()): DateStr => toLocalDate(now, timeZone);
