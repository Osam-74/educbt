-- Per-school document templates (report card / transcript / broadsheet).
--
-- Separate table (not columns on schools) on purpose: the schools tenant_self
-- policy lets a school session write its own row, which would let a principal
-- re-skin their own documents. This table is tenant-READABLE but only a
-- platform admin can write it (policies in src/db/rls.sql).
-- NULL = "inherit the platform default".
CREATE TABLE "school_document_templates" (
  "school_id" bigint PRIMARY KEY REFERENCES "schools"("id") ON DELETE CASCADE,
  "report_template" varchar(40),
  "transcript_template" varchar(40),
  "broadsheet_template" varchar(40),
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE "platform_settings"
  ADD COLUMN "default_report_template" varchar(40) DEFAULT 'classic' NOT NULL,
  ADD COLUMN "default_transcript_template" varchar(40) DEFAULT 'classic' NOT NULL,
  ADD COLUMN "default_broadsheet_template" varchar(40) DEFAULT 'classic' NOT NULL;
