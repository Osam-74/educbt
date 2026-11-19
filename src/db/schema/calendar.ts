/**
 * Academic calendar.
 *
 * Only events that PEOPLE create live here. Examinations are never copied
 * into this table: the calendar reads exam series and papers directly, so an
 * examination that moves is already moved on the calendar and can never be
 * edited into disagreement with its own record.
 *
 * Dates:
 *  - an all-day event stores plain calendar dates (`date`), which cannot
 *    drift by a day when the server and the school are in different zones;
 *  - a timed event stores the date plus a local start and end time. The
 *    school's own timezone (schools.settings.timezone) turns those into an
 *    instant when one is needed (ICS export, reminders).
 *
 * Recurrence is typed columns, not a serialized blob: a repeat rule, an
 * interval and an end date. Occurrences are worked out when read, so editing
 * the rule edits every future occurrence and no rows can fall out of step.
 */

import {
  pgTable, bigserial, bigint, varchar, text, boolean, integer, date, time, timestamp,
  index, uniqueIndex, pgEnum, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { schools, academicSessions } from './core';

export const calendarCategory = pgEnum('calendar_category', [
  'academic', 'examination', 'school_event', 'public_holiday',
  'school_holiday', 'administrative', 'deadline', 'ceremonial',
]);

/** draft: only managers see it. scheduled: planned. completed / cancelled: kept for the record, never deleted silently. */
export const calendarEventStatus = pgEnum('calendar_event_status', ['draft', 'scheduled', 'completed', 'cancelled']);

export const calendarRepeat = pgEnum('calendar_repeat', ['none', 'daily', 'weekly', 'monthly', 'yearly']);

/** Who an event is meant for. 'role' uses audience_roles, 'class' uses calendar_event_classes. */
export const calendarAudience = pgEnum('calendar_audience', ['everyone', 'staff', 'teachers', 'students', 'guardians', 'classes']);

/** One calendar per school per session: draft while being planned, published when everyone may see it, archived when the session is over. */
export const calendarState = pgEnum('calendar_state', ['draft', 'published', 'archived']);

export const academicCalendars = pgTable('academic_calendars', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull().references(() => academicSessions.id, { onDelete: 'cascade' }),
  state: calendarState('state').notNull().default('draft'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedBy: bigint('published_by', { mode: 'number' }),
  /** The secret in a read-only share link. Null until sharing is switched on; replacing it revokes the old link. */
  shareToken: varchar('share_token', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('academic_calendars_school_session_uq').on(t.schoolId, t.sessionId),
  uniqueIndex('academic_calendars_share_token_uq').on(t.shareToken).where(sql`${t.shareToken} IS NOT NULL`),
]);

export const calendarEvents = pgTable('calendar_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull().references(() => schools.id, { onDelete: 'cascade' }),
  sessionId: bigint('session_id', { mode: 'number' }).notNull().references(() => academicSessions.id, { onDelete: 'cascade' }),

  title: varchar('title', { length: 191 }).notNull(),
  description: text('description').notNull().default(''),
  category: calendarCategory('category').notNull(),
  status: calendarEventStatus('status').notNull().default('scheduled'),

  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  /** Local to the school. Both null for an all-day event. */
  startTime: time('start_time'),
  endTime: time('end_time'),
  allDay: boolean('all_day').notNull().default(true),
  venue: varchar('venue', { length: 191 }).notNull().default(''),

  audience: calendarAudience('audience').notNull().default('everyone'),
  /** Free-text staff group, such as "Heads of department". Plain text: it is a label, not a permission. */
  staffGroup: varchar('staff_group', { length: 100 }).notNull().default(''),
  /** A link to a document the school already keeps elsewhere. The calendar does not host files. */
  attachmentUrl: varchar('attachment_url', { length: 500 }).notNull().default(''),

  repeat: calendarRepeat('repeat').notNull().default('none'),
  repeatEvery: integer('repeat_every').notNull().default(1),
  repeatUntil: date('repeat_until'),

  /** Days before the start to remind people. 0 = no reminder. */
  remindDaysBefore: integer('remind_days_before').notNull().default(0),
  reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),

  /** Visible beyond the managers. A draft event is never shown to anyone else, even in a published calendar. */
  published: boolean('published').notNull().default(false),

  /** Set when a manager saved the event knowing about a warning (an exam in a holiday, say). Kept, with who and why, for the record. */
  warningOverriddenBy: bigint('warning_overridden_by', { mode: 'number' }),
  warningOverrideNote: varchar('warning_override_note', { length: 300 }).notNull().default(''),

  createdBy: bigint('created_by', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('calendar_events_school_dates_idx').on(t.schoolId, t.sessionId, t.startsOn),
  index('calendar_events_reminder_idx').on(t.schoolId, t.startsOn, t.remindDaysBefore),
  check('calendar_events_dates_ordered', sql`${t.endsOn} >= ${t.startsOn}`),
  check('calendar_events_repeat_every_positive', sql`${t.repeatEvery} >= 1 AND ${t.repeatEvery} <= 52`),
  check('calendar_events_remind_range', sql`${t.remindDaysBefore} >= 0 AND ${t.remindDaysBefore} <= 60`),
  check('calendar_events_times_consistent', sql`(${t.allDay} AND ${t.startTime} IS NULL AND ${t.endTime} IS NULL) OR (NOT ${t.allDay} AND ${t.startTime} IS NOT NULL)`),
  check('calendar_events_repeat_end', sql`${t.repeat} = 'none' OR ${t.repeatUntil} IS NULL OR ${t.repeatUntil} >= ${t.startsOn}`),
]);

/** The classes an event applies to, when its audience is 'classes'. */
export const calendarEventClasses = pgTable('calendar_event_classes', {
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  eventId: bigint('event_id', { mode: 'number' }).notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
  classId: bigint('class_id', { mode: 'number' }).notNull(),
}, (t) => [
  index('calendar_event_classes_event_idx').on(t.eventId),
  index('calendar_event_classes_class_idx').on(t.schoolId, t.classId),
]);
