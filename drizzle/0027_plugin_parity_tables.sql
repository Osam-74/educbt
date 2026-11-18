-- Plugin parity: three tables for data the WordPress plugin holds and the SaaS had no home for.
-- ADDITIVE ONLY: new tables, nothing altered or dropped, so applying this changes no existing row.
CREATE TABLE "term_summaries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"term_id" bigint NOT NULL,
	"class_id" bigint,
	"class_teacher_remark" text DEFAULT '' NOT NULL,
	"principal_remark" text DEFAULT '' NOT NULL,
	"days_present" integer DEFAULT 0 NOT NULL,
	"days_total" integer DEFAULT 0 NOT NULL,
	"subjects_offered" integer DEFAULT 0 NOT NULL,
	"total_score" numeric(10, 2) DEFAULT '0' NOT NULL,
	"average_score" numeric(6, 2) DEFAULT '0' NOT NULL,
	"class_position" integer DEFAULT 0 NOT NULL,
	"class_size" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"submitted_by" bigint,
	"submitted_at" timestamp with time zone,
	"approved_by" bigint,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_parts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"question_id" bigint NOT NULL,
	"label" varchar(10) DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"marks" numeric(8, 2) DEFAULT '0' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "school_remark_ranges" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"role" varchar(30) NOT NULL,
	"min_avg" numeric(5, 2) DEFAULT '0' NOT NULL,
	"max_avg" numeric(5, 2) DEFAULT '100' NOT NULL,
	"remark" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "term_summaries" ADD CONSTRAINT "term_summaries_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "term_summaries" ADD CONSTRAINT "term_summaries_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_parts" ADD CONSTRAINT "question_parts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "school_remark_ranges" ADD CONSTRAINT "school_remark_ranges_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "term_summaries_slot_uq" ON "term_summaries" USING btree ("student_id","term_id");
--> statement-breakpoint
CREATE INDEX "term_summaries_school_idx" ON "term_summaries" USING btree ("school_id","status");
--> statement-breakpoint
CREATE INDEX "question_parts_question_idx" ON "question_parts" USING btree ("question_id","sequence");
--> statement-breakpoint
CREATE INDEX "question_parts_school_idx" ON "question_parts" USING btree ("school_id");
--> statement-breakpoint
CREATE INDEX "school_remark_ranges_role_idx" ON "school_remark_ranges" USING btree ("school_id","role","sort_order");
