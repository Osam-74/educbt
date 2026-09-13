/**
 * Communications (legacy EduCBT Pro parity — Phase 9).
 *
 * NOTIFICATIONS are in-app, typed and user-scoped. The legacy plugin emitted
 * fourteen types, each from a specific place in the domain, so a stray string
 * could not invent a type nobody renders — that contract is kept as an enum.
 * A notification that does not take you to the thing it is about is barely a
 * notification, so every type carries a default deep link.
 *
 * PREFERENCES: in-app delivery is always honoured (muting it would only hide
 * the school's own record of what it told you); email is opt-out per user,
 * and muted types are a typed enum array — no serialized user meta blob.
 *
 * ANNOUNCEMENTS are broadcast, and the audience rules matter as much as the
 * message: a class teacher may address their own class, and only the
 * principal or deputy may address the whole school or a whole role.
 *
 * MESSAGES are threaded between named people. Student↔student messaging is
 * deliberately NOT supported — a school portal is not a chat app, and
 * moderating one is not a job any school signed up for. Guardian↔staff and
 * staff↔staff are.
 *
 * EMAIL EVENTS are a provider-independent queue drained by an Inngest
 * function: sending 500 emails inside the request that published results
 * would time out and lose messages half way through, with no record of
 * which half. Rows are final content, not templates; only a provider
 * acceptance marks a row sent.
 */

import {
  pgTable, bigserial, bigint, varchar, text, boolean, integer, timestamp,
  index, pgEnum,
} from 'drizzle-orm/pg-core';

/** Same fourteen types as the legacy service, emitted from the same places.
 *  Renaming or inventing one is a schema change, not a string edit. */
export const notificationType = pgEnum('notification_type', [
  'result_published', 'exam_scheduled', 'exam_starting', 'score_submitted',
  'promotion_approved', 'guardian_invite', 'password_reset', 'announcement',
  'message_received', 'exam_prep_opened', 'question_submitted',
  'question_withdrawn', 'question_set_deleted', 'result_approved',
]);

export const announcementAudience = pgEnum('announcement_audience', [
  'school', 'class', 'level', 'department', 'role', 'guardians',
]);

export const announcementStatus = pgEnum('announcement_status', [
  'draft', 'published',
]);

export const emailStatus = pgEnum('email_status', ['queued', 'sent', 'failed']);

export const notifications = pgTable('notifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  type: notificationType('type').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull().default(''),
  link: varchar('link', { length: 500 }).notNull().default(''),
  isRead: boolean('is_read').notNull().default(false),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('notifications_inbox_idx').on(t.schoolId, t.userId, t.createdAt),
]);

export const notificationPrefs = pgTable('notification_prefs', {
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  mutedTypes: notificationType('muted_types').array().notNull().default([]),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const announcements = pgTable('announcements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  authorUserId: bigint('author_user_id', { mode: 'number' }).notNull(),
  audience: announcementAudience('audience').notNull(),
  /** Class/level/department id, or the role string for the role audience.
   *  Null only for the school-wide audience. */
  audienceRef: bigint('audience_ref', { mode: 'number' }),
  subject: varchar('subject', { length: 200 }).notNull(),
  body: text('body').notNull(),
  status: announcementStatus('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

export const messageThreads = pgTable('message_threads', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  subject: varchar('subject', { length: 200 }).notNull(),
  createdBy: bigint('created_by', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const threadParticipants = pgTable('thread_participants', {
  threadId: bigint('thread_id', { mode: 'number' }).notNull(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  lastReadAt: timestamp('last_read_at', { withTimezone: true }),
});

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  threadId: bigint('thread_id', { mode: 'number' }).notNull(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  senderUserId: bigint('sender_user_id', { mode: 'number' }).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const emailEvents = pgTable('email_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  schoolId: bigint('school_id', { mode: 'number' }).notNull(),
  toEmail: varchar('to_email', { length: 320 }).notNull(),
  subject: varchar('subject', { length: 200 }).notNull(),
  body: text('body').notNull(),
  status: emailStatus('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  lastError: varchar('last_error', { length: 500 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});
