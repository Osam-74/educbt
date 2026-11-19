-- Plugin parity: the standalone question bank.
-- The WordPress plugin keeps questions OUTSIDE any exam set (subject, class, topic, difficulty, Bloom level,
-- exam year, duration, explanation, marking guide). The SaaS only had questions inside a set, so those details
-- had nowhere to live. Three NEW tables hold them; the existing questions/sets/papers are not touched, so
-- exam composition and the vault behave exactly as before.
-- ADDITIVE ONLY: new tables and indexes, nothing altered or dropped.
CREATE TABLE "bank_questions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"subject_id" bigint,
	"subject_name" varchar(150) DEFAULT '' NOT NULL,
	"class_label" varchar(100) DEFAULT '' NOT NULL,
	"department_label" varchar(100) DEFAULT '' NOT NULL,
	"section" varchar(100) DEFAULT '' NOT NULL,
	"topic" varchar(255) DEFAULT '' NOT NULL,
	"sub_topic" varchar(255) DEFAULT '' NOT NULL,
	"difficulty" varchar(30) DEFAULT '' NOT NULL,
	"bloom_level" varchar(50) DEFAULT '' NOT NULL,
	"learning_objective" text DEFAULT '' NOT NULL,
	"examination_type" varchar(100) DEFAULT '' NOT NULL,
	"examination_year" varchar(10) DEFAULT '' NOT NULL,
	"question_type" varchar(20) DEFAULT 'objective' NOT NULL,
	"marks" numeric(8, 2) DEFAULT '1' NOT NULL,
	"estimated_seconds" integer DEFAULT 0 NOT NULL,
	"question_text" text DEFAULT '' NOT NULL,
	"passage_text" text DEFAULT '' NOT NULL,
	"image_url" text,
	"explanation" text DEFAULT '' NOT NULL,
	"marking_guide" text DEFAULT '' NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"approval_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"review_note" text DEFAULT '' NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"source_method" varchar(30) DEFAULT 'manual' NOT NULL,
	"author_staff_id" bigint,
	"parent_id" bigint,
	"part_label" varchar(10) DEFAULT '' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_question_options" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"question_id" bigint NOT NULL,
	"option_key" varchar(10) DEFAULT '' NOT NULL,
	"option_text" text DEFAULT '' NOT NULL,
	"image_url" text,
	"is_correct" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_question_parts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"question_id" bigint NOT NULL,
	"label" varchar(10) DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"marks" numeric(8, 2) DEFAULT '0' NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_question_options" ADD CONSTRAINT "bank_question_options_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_question_options" ADD CONSTRAINT "bank_question_options_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."bank_questions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_question_parts" ADD CONSTRAINT "bank_question_parts_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bank_question_parts" ADD CONSTRAINT "bank_question_parts_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."bank_questions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "bank_questions_school_subject_idx" ON "bank_questions" USING btree ("school_id","subject_id","status");
--> statement-breakpoint
CREATE INDEX "bank_questions_topic_idx" ON "bank_questions" USING btree ("school_id","topic");
--> statement-breakpoint
CREATE INDEX "bank_question_options_question_idx" ON "bank_question_options" USING btree ("question_id","sort_order");
--> statement-breakpoint
CREATE INDEX "bank_question_parts_question_idx" ON "bank_question_parts" USING btree ("question_id","sequence");
