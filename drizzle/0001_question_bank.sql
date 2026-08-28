CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'revision');--> statement-breakpoint
CREATE TYPE "public"."delivery_mode" AS ENUM('cbt', 'written');--> statement-breakpoint
CREATE TYPE "public"."exam_type" AS ENUM('objective', 'theory');--> statement-breakpoint
CREATE TYPE "public"."passage_type" AS ENUM('comprehension', 'cloze', 'summary', 'reading_text', 'instructions', 'data', 'diagram');--> statement-breakpoint
CREATE TYPE "public"."question_type" AS ENUM('single_choice', 'multiple_choice', 'true_false', 'theory');--> statement-breakpoint
CREATE TYPE "public"."series_status" AS ENUM('draft', 'open', 'composed', 'published', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."series_type" AS ENUM('examination', 'ca_test', 'practice');--> statement-breakpoint
CREATE TYPE "public"."set_status" AS ENUM('draft', 'submitted', 'under_review', 'returned', 'approved', 'published');--> statement-breakpoint
CREATE TABLE "exam_series" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"term_id" bigint,
	"title" varchar(191) NOT NULL,
	"series_type" "series_type" DEFAULT 'examination' NOT NULL,
	"component_id" bigint,
	"questions_open_from" timestamp with time zone,
	"questions_open_to" timestamp with time zone,
	"questions_per_student" integer DEFAULT 0 NOT NULL,
	"duration_minutes" integer DEFAULT 0 NOT NULL,
	"status" "series_status" DEFAULT 'draft' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"subject_id" bigint,
	"title" varchar(191) NOT NULL,
	"passage_type" "passage_type" DEFAULT 'comprehension' NOT NULL,
	"body" text NOT NULL,
	"image_url" text,
	"author_staff_id" bigint,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_options" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"question_id" bigint NOT NULL,
	"option_key" varchar(5),
	"option_text" text NOT NULL,
	"image_url" text,
	"is_correct" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_sets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"term_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"level_id" bigint NOT NULL,
	"department_id" bigint,
	"class_id" bigint,
	"exam_type" "exam_type" NOT NULL,
	"delivery_mode" "delivery_mode" DEFAULT 'cbt' NOT NULL,
	"waec_mode" boolean DEFAULT false NOT NULL,
	"series_id" bigint DEFAULT 0 NOT NULL,
	"teacher_id" bigint,
	"default_marks" numeric(6, 2) DEFAULT '1.00' NOT NULL,
	"min_required" integer DEFAULT 0 NOT NULL,
	"status" "set_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by" bigint,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" bigint,
	"reviewer_comment" text,
	"revision_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"question_set_id" bigint NOT NULL,
	"question_text" text NOT NULL,
	"question_type" "question_type" DEFAULT 'single_choice' NOT NULL,
	"image_url" text,
	"instructions" text,
	"passage_id" bigint,
	"section" varchar(100) DEFAULT '' NOT NULL,
	"marks" numeric(6, 2) DEFAULT '1.00' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"no_shuffle" boolean DEFAULT false NOT NULL,
	"marking_guide" text,
	"explanation" text,
	"approval_status" "approval_status" DEFAULT 'pending' NOT NULL,
	"reviewer_comment" text,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"parent_id" bigint,
	"part_label" varchar(20),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exam_series" ADD CONSTRAINT "exam_series_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_series" ADD CONSTRAINT "exam_series_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_series" ADD CONSTRAINT "exam_series_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passages" ADD CONSTRAINT "passages_author_staff_id_staff_id_fk" FOREIGN KEY ("author_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_options" ADD CONSTRAINT "question_options_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_session_id_academic_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."academic_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_term_id_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_level_id_class_levels_id_fk" FOREIGN KEY ("level_id") REFERENCES "public"."class_levels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_class_id_classes_id_fk" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_sets" ADD CONSTRAINT "question_sets_teacher_id_staff_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_question_set_id_question_sets_id_fk" FOREIGN KEY ("question_set_id") REFERENCES "public"."question_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_passage_id_passages_id_fk" FOREIGN KEY ("passage_id") REFERENCES "public"."passages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "series_school_idx" ON "exam_series" USING btree ("school_id","session_id","term_id");--> statement-breakpoint
CREATE INDEX "series_type_idx" ON "exam_series" USING btree ("school_id","series_type","status");--> statement-breakpoint
CREATE INDEX "passages_school_idx" ON "passages" USING btree ("school_id","subject_id");--> statement-breakpoint
CREATE INDEX "options_question_idx" ON "question_options" USING btree ("question_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "question_sets_scope_uq" ON "question_sets" USING btree ("school_id","session_id","term_id","subject_id","level_id","department_id","exam_type","series_id","waec_mode");--> statement-breakpoint
CREATE INDEX "sets_school_idx" ON "question_sets" USING btree ("school_id","status");--> statement-breakpoint
CREATE INDEX "sets_teacher_idx" ON "question_sets" USING btree ("teacher_id");--> statement-breakpoint
CREATE INDEX "questions_set_idx" ON "questions" USING btree ("question_set_id","status");--> statement-breakpoint
CREATE INDEX "questions_section_idx" ON "questions" USING btree ("question_set_id","section");--> statement-breakpoint
CREATE INDEX "questions_school_idx" ON "questions" USING btree ("school_id");