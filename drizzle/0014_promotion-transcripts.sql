-- Promotion and transcripts (legacy EduCBT Pro parity).
--
-- Promotion is a STORED PROPOSAL, applied only by the principal's commit: the
-- batch keeps the ruleset snapshot and per-student decisions (proposed + final
-- + override reason), and commit writes ONLY next session's enrollments —
-- history is never overwritten.
--
-- Transcripts are issued documents: serial, purpose, issuer, status
-- (issued/reissued/revoked) and a snapshot of terms recorded + cumulative
-- average at issue time. Verification is a server-side HMAC over the serial,
-- not a stored checksum.

CREATE TYPE "promotion_outcome" AS ENUM ('promote', 'trial', 'repeat', 'graduate', 'unresolved');
CREATE TYPE "promotion_status" AS ENUM ('proposed', 'committed', 'reversed');
CREATE TYPE "transcript_status" AS ENUM ('issued', 'reissued', 'revoked');

CREATE TABLE "promotion_batches" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "from_session_id" bigint NOT NULL,
  "to_session_id" bigint NOT NULL,
  "level_id" bigint NOT NULL,
  "rules" jsonb,
  "total_evaluated" integer DEFAULT 0 NOT NULL,
  "total_promoted" integer DEFAULT 0 NOT NULL,
  "total_trial" integer DEFAULT 0 NOT NULL,
  "total_repeated" integer DEFAULT 0 NOT NULL,
  "total_graduated" integer DEFAULT 0 NOT NULL,
  "total_unresolved" integer DEFAULT 0 NOT NULL,
  "status" "promotion_status" DEFAULT 'proposed' NOT NULL,
  "created_by" bigint,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "committed_by" bigint,
  "committed_at" timestamptz,
  "reversed_by" bigint,
  "reversed_at" timestamptz
);
CREATE INDEX "promotion_batches_scope_idx" ON "promotion_batches" ("school_id", "status");
CREATE INDEX "promotion_batches_from_idx" ON "promotion_batches" ("school_id", "from_session_id", "level_id");

CREATE TABLE "promotion_decisions" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "batch_id" bigint NOT NULL,
  "student_id" bigint NOT NULL,
  "from_class_id" bigint,
  "to_class_id" bigint,
  "proposed_outcome" "promotion_outcome" DEFAULT 'promote' NOT NULL,
  "final_outcome" "promotion_outcome" DEFAULT 'promote' NOT NULL,
  "average_score" numeric(6, 2) DEFAULT 0 NOT NULL,
  "subjects_passed" integer DEFAULT 0 NOT NULL,
  "subjects_offered" integer DEFAULT 0 NOT NULL,
  "note" varchar(100) DEFAULT '' NOT NULL,
  "override_reason" varchar(255) DEFAULT '' NOT NULL,
  "overridden_by" bigint,
  "overridden_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "promotion_decisions_batch_student_uq" ON "promotion_decisions" ("batch_id", "student_id");
CREATE INDEX "promotion_decisions_student_idx" ON "promotion_decisions" ("student_id");
CREATE INDEX "promotion_decisions_school_idx" ON "promotion_decisions" ("school_id");

CREATE TABLE "transcripts" (
  "id" bigserial PRIMARY KEY,
  "school_id" bigint NOT NULL,
  "student_id" bigint NOT NULL,
  "serial" varchar(60) NOT NULL,
  "purpose" varchar(255) DEFAULT '' NOT NULL,
  "terms_recorded" integer DEFAULT 0 NOT NULL,
  "cumulative_average" numeric(6, 2) DEFAULT 0 NOT NULL,
  "issued_by" bigint,
  "issued_at" timestamptz DEFAULT now() NOT NULL,
  "status" "transcript_status" DEFAULT 'issued' NOT NULL,
  "revoke_reason" varchar(255) DEFAULT '' NOT NULL,
  "revoked_by" bigint,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "transcripts_serial_uq" ON "transcripts" ("serial");
CREATE INDEX "transcripts_school_student_idx" ON "transcripts" ("school_id", "student_id");
CREATE INDEX "transcripts_issued_idx" ON "transcripts" ("school_id", "status");
