CREATE TABLE "assessment_scores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"school_id" bigint NOT NULL,
	"student_id" bigint NOT NULL,
	"subject_id" bigint NOT NULL,
	"session_id" bigint NOT NULL,
	"term_id" bigint NOT NULL,
	"component_key" varchar(50) NOT NULL,
	"score" numeric(6, 2) DEFAULT '0' NOT NULL,
	"max_score" numeric(6, 2) DEFAULT '0' NOT NULL,
	"entered_by" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_scores_uq" ON "assessment_scores" USING btree ("student_id","subject_id","term_id","component_key");--> statement-breakpoint
CREATE INDEX "assessment_scores_scope_idx" ON "assessment_scores" USING btree ("school_id","subject_id","term_id");