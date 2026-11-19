-- Plugin parity: the exam history of a school that came over from the WordPress plugin.
-- A plugin paper draws from the standalone question bank, and a SaaS attempt can only point at a set-based question,
-- so papers and attempts cannot be re-created as live SaaS exams without inventing sets the school never made.
-- They are kept instead as a read-only HISTORY: nothing the school recorded is lost, and no live exam table is touched.
-- Each row keeps the queryable facts as real columns AND the plugin's original row verbatim in "source", so even a
-- column this code does not know about (or a later plugin version adds) is never lost.
-- ADDITIVE ONLY: new tables and indexes, nothing altered or dropped.
CREATE TABLE "legacy_exam_papers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"kind" varchar(20) NOT NULL,
	"source_id" bigint NOT NULL,
	"series_source_id" bigint,
	"title" varchar(255) DEFAULT '' NOT NULL,
	"series_type" varchar(30) DEFAULT '' NOT NULL,
	"subject_id" bigint,
	"subject_name" varchar(150) DEFAULT '' NOT NULL,
	"class_id" bigint,
	"class_name" varchar(100) DEFAULT '' NOT NULL,
	"session_id" bigint,
	"term_id" bigint,
	"status" varchar(30) DEFAULT '' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"question_count" integer DEFAULT 0 NOT NULL,
	"total_marks" numeric(10, 2) DEFAULT '0' NOT NULL,
	"source" jsonb NOT NULL,
	"questions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_exam_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"kind" varchar(20) NOT NULL,
	"source_id" bigint NOT NULL,
	"paper_id" bigint,
	"student_id" bigint,
	"status" varchar(30) DEFAULT '' NOT NULL,
	"submit_reason" varchar(30) DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"graded_at" timestamp with time zone,
	"extension_seconds" integer DEFAULT 0 NOT NULL,
	"raw_score" numeric(10, 2),
	"max_score" numeric(10, 2),
	"percentage" numeric(6, 2),
	"flag_count" integer DEFAULT 0 NOT NULL,
	"integrity_count" integer DEFAULT 0 NOT NULL,
	"question_order" jsonb NOT NULL,
	"source" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_attempt_answers" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"attempt_id" bigint NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"question_source_id" bigint,
	"question_text" text DEFAULT '' NOT NULL,
	"chosen_option" text,
	"correct_option" text,
	"answer_text" text,
	"is_correct" boolean,
	"marks_awarded" numeric(8, 2),
	"marks_available" numeric(8, 2),
	"answered_at" timestamp with time zone,
	"source" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_attempt_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"attempt_id" bigint NOT NULL,
	"event_type" varchar(60) DEFAULT '' NOT NULL,
	"occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_exam_papers" ADD CONSTRAINT "legacy_exam_papers_school_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_exam_attempts" ADD CONSTRAINT "legacy_exam_attempts_school_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_exam_attempts" ADD CONSTRAINT "legacy_exam_attempts_paper_fk" FOREIGN KEY ("paper_id") REFERENCES "public"."legacy_exam_papers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_exam_attempts" ADD CONSTRAINT "legacy_exam_attempts_student_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_attempt_answers" ADD CONSTRAINT "legacy_attempt_answers_school_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_attempt_answers" ADD CONSTRAINT "legacy_attempt_answers_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."legacy_exam_attempts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_attempt_events" ADD CONSTRAINT "legacy_attempt_events_school_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "legacy_attempt_events" ADD CONSTRAINT "legacy_attempt_events_attempt_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."legacy_exam_attempts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_exam_papers_source_uq" ON "legacy_exam_papers" USING btree ("school_id","kind","source_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_exam_attempts_source_uq" ON "legacy_exam_attempts" USING btree ("school_id","kind","source_id");
--> statement-breakpoint
CREATE INDEX "legacy_exam_attempts_student_idx" ON "legacy_exam_attempts" USING btree ("school_id","student_id");
--> statement-breakpoint
CREATE INDEX "legacy_attempt_answers_attempt_idx" ON "legacy_attempt_answers" USING btree ("attempt_id","position");
--> statement-breakpoint
CREATE INDEX "legacy_attempt_events_attempt_idx" ON "legacy_attempt_events" USING btree ("attempt_id");
