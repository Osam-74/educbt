-- Authentication & account recovery completion.
--
-- 1. users.email: an OPTIONAL recovery address. Students never need one.
--    Uniqueness is global on lower(email): a recovery email resolves to at
--    most ONE account, which is what makes the forgot-password lookup
--    unambiguous across schools. Two schools can still share a login_id.
--    Verification (email_verified_at) can only be set by the verification
--    flow, never at write time.
--
-- 2. sessions.totp_pending: staged two-step sign-in. Credentials verified,
--    but the TOTP/recovery-code step has not happened yet. A pending
--    session authorises NOTHING — readSessionUser returns null for it.
--    It lives 15 minutes and is finalised only by a valid code.
--
-- 3. password_reset_tokens: short-lived single-use password reset. The
--    table stores ONLY the SHA-256 of the raw token, exactly like sessions.
--    Row-level security is disabled for the same reason as sessions: the
--    row is found by an unguessable primary key BEFORE any tenant exists,
--    and the table holds no tenant data of its own.
--
-- 4. totp_recovery_codes: one-time codes issued at TOTP enrollment. Only
--    SHA-256 hashes are stored. Looked up by user_id (not by an unguessable
--    key), so this table IS row-level secured.

-- ── users: recovery email ────────────────────────────────────────────────────

ALTER TABLE "users" ADD COLUMN "email" varchar(320);
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lc_uq" ON "users" (lower("email")) WHERE "email" IS NOT NULL;
--> statement-breakpoint

-- ── sessions: staged two-step sign-in ────────────────────────────────────────

ALTER TABLE "sessions" ADD COLUMN "totp_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- ── password reset tokens ─────────────────────────────────────────────────────

CREATE TABLE "password_reset_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" varchar(191) NOT NULL,
	"user_id" bigint NOT NULL,
	"school_id" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_ip" inet,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_uq" ON "password_reset_tokens" ("token_hash");
--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" ("user_id", "created_at");
--> statement-breakpoint
-- Unguessable primary key reached pre-tenant, exactly like sessions: no RLS.
ALTER TABLE "password_reset_tokens" DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── TOTP recovery codes ──────────────────────────────────────────────────────

CREATE TABLE "totp_recovery_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"school_id" bigint,
	"code_hash" varchar(191) NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "totp_recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "totp_recovery_codes_user_idx" ON "totp_recovery_codes" ("user_id", "used_at");
--> statement-breakpoint
ALTER TABLE "totp_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "totp_recovery_codes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Password-reset emails for PLATFORM ADMIN accounts own no tenant. The queue
-- itself is the delivery record; platform rows carry a NULL school scope.
ALTER TABLE "email_events" ALTER COLUMN "school_id" DROP NOT NULL;
