-- Platform-level state for restoring a school from an uploaded backup file.
-- No school_id: the school being restored does not exist yet. Both tables are platform-admin-only
-- (rls.sql). The job row holds status and progress, never a password or any school data; chunks hold
-- the uploaded file in slices small enough for Vercel's 4.5 MB request limit.
CREATE TYPE "public"."backup_job_status" AS ENUM ('uploading', 'queued', 'restoring', 'succeeded', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TABLE "school_backup_jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_by" bigint NOT NULL,
	"status" "backup_job_status" DEFAULT 'uploading' NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"total_bytes" bigint NOT NULL,
	"total_chunks" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"new_school_code" varchar(64) NOT NULL,
	"new_school_subdomain" varchar(64),
	"new_school_name" varchar(200),
	"restored_school_id" bigint,
	"error_message" text,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "school_backup_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job_id" bigint NOT NULL,
	"position" integer NOT NULL,
	"data" bytea NOT NULL,
	"byte_size" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "school_backup_chunks" ADD CONSTRAINT "school_backup_chunks_job_id_school_backup_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."school_backup_jobs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "school_backup_jobs_status_idx" ON "school_backup_jobs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "school_backup_chunks_job_pos_uq" ON "school_backup_chunks" USING btree ("job_id","position");
