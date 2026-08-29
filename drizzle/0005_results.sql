CREATE TABLE "subject_results" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"term_id" bigint NOT NULL,
	"ca_total" numeric(6, 2) DEFAULT '0' NOT NULL,
	"exam_total" numeric(6, 2) DEFAULT '0' NOT NULL,
	"total" numeric(6, 2) DEFAULT '0' NOT NULL,
	"grade" varchar(10) DEFAULT '' NOT NULL,
	"remark" varchar(100) DEFAULT '' NOT NULL,
	"subject_position" integer DEFAULT 0 NOT NULL,
	"class_size" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"compiled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subject_results_uq" ON "subject_results" USING btree ("student_id","subject_id","session_id","term_id");--> statement-breakpoint
CREATE INDEX "subject_results_scope_idx" ON "subject_results" USING btree ("school_id","session_id","term_id","subject_id");