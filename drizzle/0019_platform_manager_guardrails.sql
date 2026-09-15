-- Platform manager guardrails (manager-creation feature).
--
-- The users table's uniqueness constraint is SCOPED: users_school_login_uq on
-- (school_id, login_id). That is the whole multi-tenant auth design — the
-- same staff number may exist in two different schools — but NULL
-- school_id rows (platform accounts) NEVER collide under a scoped unique
-- index, because NULL != NULL in Postgres. Two platform managers could
-- therefore share a sign-in ID, and sign-in would resolve to whichever the
-- query happened to find first.
--
-- This partial unique index closes that hole for platform accounts only:
-- login IDs must be unique among school_id IS NULL users. School tenants
-- keep their scoped constraint and are untouched. RLS is unaffected — this
-- is a constraint, not a policy.
CREATE UNIQUE INDEX "users_platform_login_uq"
  ON "users" ("login_id")
  WHERE "school_id" IS NULL AND "role" = 'platform_admin';
