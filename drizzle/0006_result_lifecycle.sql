CREATE TYPE "public"."result_state" AS ENUM('draft', 'compiled', 'reviewed', 'published', 'locked');--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "grading_scale_id" varchar(50) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "grading_scale_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "ranking_policy" jsonb;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "state" "result_state" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subject_results" ADD COLUMN "locked_at" timestamp with time zone;