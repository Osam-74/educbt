-- Communications: notifications, announcements, messages, email queue.
--
-- Legacy parity with three deliberate departures:
--   * No JSON payload blob on notifications. The legacy plugin stuffed an
--     untyped JSON payload on every row and no renderer ever read it. Here a
--     notification is typed columns only; the deep link carries the context.
--   * Muted types are a typed enum array, not serialized user meta.
--   * Email delivery is a provider-independent event table consumed by an
--     Inngest function, not rows polled by WP-Cron.
--
-- Announcement audience rules are enforced in the service AND the capability
-- check: a class teacher may address their own class; only the principal or
-- deputy may address the whole school or a whole role. Messages are threaded
-- and staff↔staff / guardian↔staff only — student↔student is deliberately not
-- supported (legacy made the same call).

CREATE TYPE "notification_type" AS ENUM (
  'result_published', 'exam_scheduled', 'exam_starting', 'score_submitted',
  'promotion_approved', 'guardian_invite', 'password_reset', 'announcement',
  'message_received', 'exam_prep_opened', 'question_submitted',
  'question_withdrawn', 'question_set_deleted', 'result_approved'
);
CREATE TYPE "announcement_audience" AS ENUM (
  'school', 'class', 'level', 'department', 'role', 'guardians'
);
CREATE TYPE "announcement_status" AS ENUM ('draft', 'published');
CREATE TYPE "email_status" AS ENUM ('queued', 'sent', 'failed');

CREATE TABLE "notifications" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "type" "notification_type" NOT NULL,
  "title" varchar(200) NOT NULL,
  "body" text DEFAULT '' NOT NULL,
  "link" varchar(500) DEFAULT '' NOT NULL,
  "is_read" boolean DEFAULT false NOT NULL,
  "read_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "notifications_inbox_idx" ON "notifications" ("school_id", "user_id", "created_at" DESC);
CREATE INDEX "notifications_unread_idx" ON "notifications" ("school_id", "user_id") WHERE NOT "is_read";

-- One preferences row per user per school. in_app is always honoured: an
-- in-app notification costs nothing and muting it only hides the school's
-- own record of what it told you. email_enabled and muted_types control
-- the email fan-out only.
CREATE TABLE "notification_prefs" (
  "school_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "email_enabled" boolean DEFAULT true NOT NULL,
  "muted_types" "notification_type"[] DEFAULT '{}' NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("school_id", "user_id")
);

CREATE TABLE "announcements" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "author_user_id" bigint NOT NULL,
  "audience" "announcement_audience" NOT NULL,
  "audience_ref" bigint,
  "subject" varchar(200) NOT NULL,
  "body" text NOT NULL,
  "status" "announcement_status" DEFAULT 'draft' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "published_at" timestamptz
);
CREATE INDEX "announcements_scope_idx" ON "announcements" ("school_id", "status", "created_at" DESC);

CREATE TABLE "message_threads" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "subject" varchar(200) NOT NULL,
  "created_by" bigint NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "message_threads_scope_idx" ON "message_threads" ("school_id", "created_at" DESC);

CREATE TABLE "thread_participants" (
  "thread_id" bigint NOT NULL REFERENCES "message_threads" ("id") ON DELETE CASCADE,
  "school_id" bigint NOT NULL,
  "user_id" bigint NOT NULL,
  "last_read_at" timestamptz,
  PRIMARY KEY ("thread_id", "user_id")
);
CREATE INDEX "thread_participants_user_idx" ON "thread_participants" ("school_id", "user_id", "thread_id");

CREATE TABLE "messages" (
  "id" bigserial PRIMARY KEY,
  "thread_id" bigint NOT NULL REFERENCES "message_threads" ("id") ON DELETE CASCADE,
  "school_id" bigint NOT NULL,
  "sender_user_id" bigint NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "messages_thread_idx" ON "messages" ("thread_id", "created_at");

-- Provider-independent email queue. Rows are events, not templates: the
-- subject and body are final, the address is checked at enqueue time, and
-- an Inngest function drains the queue with retry + backoff. A row is only
-- 'sent' when the provider accepted it; 'failed' keeps last_error for the
-- office to read, exactly like the legacy queue kept its error column.
CREATE TABLE "email_events" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "to_email" varchar(320) NOT NULL,
  "subject" varchar(200) NOT NULL,
  "body" text NOT NULL,
  "status" "email_status" DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" varchar(500),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "sent_at" timestamptz
);
CREATE INDEX "email_events_drain_idx" ON "email_events" ("status", "created_at") WHERE "status" = 'queued';
CREATE INDEX "email_events_scope_idx" ON "email_events" ("school_id", "created_at" DESC);
