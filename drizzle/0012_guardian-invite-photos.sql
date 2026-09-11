-- Guardian invites: a school never holds a parent's credentials. The link is
-- created with a one-time token; the parent redeems it to set their own
-- password (legacy guardian_student invite_token / invite_status). The
-- redeem flow is a later block; the school-side token creation lands here.
ALTER TABLE "guardians" ADD COLUMN "invite_token" varchar(191);
ALTER TABLE "guardians" ADD COLUMN "invite_status" varchar(20) DEFAULT 'none' NOT NULL;

-- Passport photographs, stored in the tenant database rather than a media
-- library. The app is self-contained (one Postgres, no object storage), and
-- a bytea column keeps photos inside the same tenant isolation and backup
-- stream as every other school record.
CREATE TABLE "portal_uploads" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL REFERENCES "schools"("id") ON DELETE CASCADE,
  -- Unguessable, so the public serve route (/api/photos/[token]) needs no
  -- session: the token IS the capability, like a signed S3 URL. Report-card
  -- print pipelines (WeasyPrint/headless Chrome) cannot carry cookies.
  "token" varchar(64) NOT NULL,
  "mime_type" varchar(100) NOT NULL,
  "byte_size" bigint NOT NULL,
  "data" bytea NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "portal_uploads_token_uq" ON "portal_uploads" ("token");
CREATE INDEX "portal_uploads_school_idx" ON "portal_uploads" ("school_id");
