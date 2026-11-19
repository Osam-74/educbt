/**
 * Server-side validation of an event. The form checks too, but a request can be
 * made without the form, so every rule lives here and the action calls it.
 */
import { isDateStr } from './dates';
import type { Category } from './engine';

export const CATEGORIES: Category[] = ['academic', 'examination', 'school_event', 'public_holiday', 'school_holiday', 'administrative', 'deadline', 'ceremonial'];
export const STATUSES = ['draft', 'scheduled', 'completed', 'cancelled'] as const;
export const REPEATS = ['none', 'daily', 'weekly', 'monthly', 'yearly'] as const;
export const AUDIENCES = ['everyone', 'staff', 'teachers', 'students', 'guardians', 'classes'] as const;

export type EventInput = {
  title: string; description: string; category: Category; status: (typeof STATUSES)[number];
  startsOn: string; endsOn: string; allDay: boolean; startTime: string | null; endTime: string | null;
  venue: string; audience: (typeof AUDIENCES)[number]; staffGroup: string; attachmentUrl: string;
  classIds: number[]; repeat: (typeof REPEATS)[number]; repeatEvery: number; repeatUntil: string | null;
  remindDaysBefore: number; published: boolean; overrideNote: string;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);

/** Returns the cleaned event, or the list of things wrong with it in plain words. */
export function validateEvent(raw: Record<string, unknown>): { ok: true; value: EventInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const title = text(raw.title, 191);
  if (!title) errors.push('Give the event a title.');
  const category = oneOf(raw.category, CATEGORIES);
  if (!category) errors.push('Choose a category.');
  const status = oneOf(raw.status ?? 'scheduled', STATUSES);
  if (!status) errors.push('Choose a status.');

  const startsOn = String(raw.startsOn ?? ''), endsOnRaw = String(raw.endsOn ?? '') || startsOn;
  if (!isDateStr(startsOn)) errors.push('Choose a valid start date.');
  if (!isDateStr(endsOnRaw)) errors.push('Choose a valid end date.');
  if (isDateStr(startsOn) && isDateStr(endsOnRaw) && endsOnRaw < startsOn) errors.push('The end date cannot be before the start date.');
  if (isDateStr(startsOn) && isDateStr(endsOnRaw) && (Date.parse(endsOnRaw) - Date.parse(startsOn)) / 86_400_000 > 366) errors.push('An event cannot last more than a year.');

  const allDay = raw.allDay === true || raw.allDay === 'true' || raw.allDay === 'on' || raw.allDay === undefined;
  let startTime: string | null = null, endTime: string | null = null;
  if (!allDay) {
    startTime = text(raw.startTime, 5) || null; endTime = text(raw.endTime, 5) || null;
    if (!startTime || !TIME.test(startTime)) errors.push('Give a start time, such as 09:00, or tick All day.');
    if (endTime && !TIME.test(endTime)) errors.push('The end time should look like 14:30.');
    if (startTime && endTime && TIME.test(startTime) && TIME.test(endTime) && startsOn === endsOnRaw && endTime <= startTime) errors.push('The end time must be after the start time.');
  }

  const audience = oneOf(raw.audience ?? 'everyone', AUDIENCES);
  if (!audience) errors.push('Choose who the event is for.');
  const classIds = Array.isArray(raw.classIds) ? [...new Set(raw.classIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];
  if (audience === 'classes' && classIds.length === 0) errors.push('Choose at least one class, or change who the event is for.');

  const repeat = oneOf(raw.repeat ?? 'none', REPEATS);
  if (!repeat) errors.push('Choose how the event repeats.');
  const repeatEvery = Number(raw.repeatEvery ?? 1);
  if (!Number.isInteger(repeatEvery) || repeatEvery < 1 || repeatEvery > 52) errors.push('"Repeat every" must be a whole number from 1 to 52.');
  const repeatUntil = text(raw.repeatUntil, 10) || null;
  if (repeat && repeat !== 'none') {
    if (!repeatUntil) errors.push('Say when the repeating should stop.');
    else if (!isDateStr(repeatUntil)) errors.push('Choose a valid date for the repeating to stop.');
    else if (isDateStr(startsOn) && repeatUntil < startsOn) errors.push('The repeating must stop after the event starts.');
  }
  const remind = Number(raw.remindDaysBefore ?? 0);
  if (!Number.isInteger(remind) || remind < 0 || remind > 60) errors.push('Reminders can be set from 0 to 60 days before.');

  const attachmentUrl = text(raw.attachmentUrl, 500);
  if (attachmentUrl && !/^https:\/\/[^\s]+$/i.test(attachmentUrl)) errors.push('The attachment link must start with https://');

  if (errors.length || !category || !status || !audience || !repeat) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title, description: text(raw.description, 4000), category, status, startsOn, endsOn: endsOnRaw, allDay, startTime, endTime,
      venue: text(raw.venue, 191), audience, staffGroup: text(raw.staffGroup, 100), attachmentUrl,
      classIds: audience === 'classes' ? classIds : [], repeat, repeatEvery,
      repeatUntil: repeat === 'none' ? null : repeatUntil, remindDaysBefore: remind,
      published: raw.published === true || raw.published === 'true' || raw.published === 'on', overrideNote: text(raw.overrideNote, 300),
    },
  };
}
