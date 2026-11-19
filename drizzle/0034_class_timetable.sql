-- Class teaching timetable. ADDITIVE ONLY: new tables and indexes; nothing altered or dropped.
-- A class has one lesson per weekday and period, and a teacher is in one place per weekday and period; both are unique
-- indexes, so a clash is impossible even when two people save at the same moment.
CREATE TABLE "timetable_periods" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"name" varchar(60) NOT NULL,
	"position" integer NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"is_break" boolean DEFAULT false NOT NULL,
	CONSTRAINT "timetable_periods_times_ordered" CHECK ("timetable_periods"."end_time" > "timetable_periods"."start_time")
);
--> statement-breakpoint
CREATE TABLE "timetable_lessons" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"period_id" bigint NOT NULL,
	"weekday" integer NOT NULL,
	"subject_id" bigint NOT NULL,
	"staff_id" bigint,
	"room" varchar(60) DEFAULT '' NOT NULL,
	"created_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timetable_lessons_weekday_range" CHECK ("timetable_lessons"."weekday" BETWEEN 1 AND 7)
);
--> statement-breakpoint
CREATE TABLE "timetable_publication" (
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"class_id" bigint NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" bigint
);
--> statement-breakpoint
ALTER TABLE "timetable_periods" ADD CONSTRAINT "timetable_periods_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_period_id_timetable_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."timetable_periods"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_lessons" ADD CONSTRAINT "timetable_lessons_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_publication" ADD CONSTRAINT "timetable_publication_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_publication" ADD CONSTRAINT "timetable_publication_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "timetable_publication" ADD CONSTRAINT "timetable_publication_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_periods_school_position_uq" ON "timetable_periods" USING btree ("school_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_lessons_class_slot_uq" ON "timetable_lessons" USING btree ("session_id","class_id","weekday","period_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_lessons_teacher_slot_uq" ON "timetable_lessons" USING btree ("session_id","staff_id","weekday","period_id") WHERE "timetable_lessons"."staff_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "timetable_lessons_class_idx" ON "timetable_lessons" USING btree ("school_id","session_id","class_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "timetable_publication_uq" ON "timetable_publication" USING btree ("session_id","class_id");
