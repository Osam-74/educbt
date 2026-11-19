-- Academic calendar. ADDITIVE ONLY: new enums, new tables and indexes; nothing altered or dropped.
-- Examinations are NOT copied here: the calendar reads exam series and papers directly, so a moved exam is already moved on the calendar.
-- All-day dates are plain dates (no timezone drift); a timed event keeps a local start and end time that the school's own timezone turns into an instant.
CREATE TYPE "public"."calendar_category" AS ENUM('academic', 'examination', 'school_event', 'public_holiday', 'school_holiday', 'administrative', 'deadline', 'ceremonial');
--> statement-breakpoint
CREATE TYPE "public"."calendar_event_status" AS ENUM('draft', 'scheduled', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."calendar_repeat" AS ENUM('none', 'daily', 'weekly', 'monthly', 'yearly');
--> statement-breakpoint
CREATE TYPE "public"."calendar_audience" AS ENUM('everyone', 'staff', 'teachers', 'students', 'guardians', 'classes');
--> statement-breakpoint
CREATE TYPE "public"."calendar_state" AS ENUM('draft', 'published', 'archived');
--> statement-breakpoint
CREATE TABLE "academic_calendars" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"state" "calendar_state" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" bigint,
	"share_token" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"title" varchar(191) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" "calendar_category" NOT NULL,
	"status" "calendar_event_status" DEFAULT 'scheduled' NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"start_time" time,
	"end_time" time,
	"all_day" boolean DEFAULT true NOT NULL,
	"venue" varchar(191) DEFAULT '' NOT NULL,
	"audience" "calendar_audience" DEFAULT 'everyone' NOT NULL,
	"staff_group" varchar(100) DEFAULT '' NOT NULL,
	"attachment_url" varchar(500) DEFAULT '' NOT NULL,
	"repeat" "calendar_repeat" DEFAULT 'none' NOT NULL,
	"repeat_every" integer DEFAULT 1 NOT NULL,
	"repeat_until" date,
	"remind_days_before" integer DEFAULT 0 NOT NULL,
	"reminder_sent_at" timestamp with time zone,
	"published" boolean DEFAULT false NOT NULL,
	"warning_overridden_by" bigint,
	"warning_override_note" varchar(300) DEFAULT '' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_dates_ordered" CHECK ("calendar_events"."ends_on" >= "calendar_events"."starts_on"),
	CONSTRAINT "calendar_events_repeat_every_positive" CHECK ("calendar_events"."repeat_every" >= 1 AND "calendar_events"."repeat_every" <= 52),
	CONSTRAINT "calendar_events_remind_range" CHECK ("calendar_events"."remind_days_before" >= 0 AND "calendar_events"."remind_days_before" <= 60),
	CONSTRAINT "calendar_events_times_consistent" CHECK (("calendar_events"."all_day" AND "calendar_events"."start_time" IS NULL AND "calendar_events"."end_time" IS NULL) OR (NOT "calendar_events"."all_day" AND "calendar_events"."start_time" IS NOT NULL)),
	CONSTRAINT "calendar_events_repeat_end" CHECK ("calendar_events"."repeat" = 'none' OR "calendar_events"."repeat_until" IS NULL OR "calendar_events"."repeat_until" >= "calendar_events"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "calendar_event_classes" (
	"school_id" bigint NOT NULL,
	"event_id" bigint NOT NULL,
	"class_id" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD CONSTRAINT "academic_calendars_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "academic_calendars" ADD CONSTRAINT "academic_calendars_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_event_classes" ADD CONSTRAINT "calendar_event_classes_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "academic_calendars_school_session_uq" ON "academic_calendars" USING btree ("school_id","session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "academic_calendars_share_token_uq" ON "academic_calendars" USING btree ("share_token") WHERE "academic_calendars"."share_token" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "calendar_events_school_dates_idx" ON "calendar_events" USING btree ("school_id","session_id","starts_on");
--> statement-breakpoint
CREATE INDEX "calendar_events_reminder_idx" ON "calendar_events" USING btree ("school_id","starts_on","remind_days_before");
--> statement-breakpoint
CREATE INDEX "calendar_event_classes_event_idx" ON "calendar_event_classes" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "calendar_event_classes_class_idx" ON "calendar_event_classes" USING btree ("school_id","class_id");
