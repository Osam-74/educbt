-- ════════════════════════════════════════════════════════════════════════════
-- Row-Level Security
--
-- This is the tenancy safety net. Every school-owned table filters on a session
-- variable set per request. A query that forgets `WHERE school_id = ...` returns
-- ZERO ROWS instead of another school's students.
--
-- The old system relied on every developer remembering the scope in every query.
-- That worked until it did not, and the failure mode was silent.
--
-- HOW IT WORKS
--   1. Every request sets  SET LOCAL app.school_id = '<id>'
--   2. Policies compare school_id against that setting
--   3. LOCAL means it is scoped to the transaction and cannot leak between
--      pooled connections — critical, because PgBouncer reuses connections
--      across requests from different schools.
--
-- THE APPLICATION ROLE MUST NOT BE SUPERUSER OR TABLE OWNER.
-- Postgres exempts both from RLS. Running as the owner silently disables every
-- policy in this file while leaving them visibly present, which is worse than
-- having none at all.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Application role ────────────────────────────────────────────────────────
-- Create once, by hand, with the owner role. Not part of migrations.
--
--   CREATE ROLE educbt_app LOGIN PASSWORD '...';
--   GRANT USAGE ON SCHEMA public TO educbt_app;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO educbt_app;
--   GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO educbt_app;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO educbt_app;

-- Reads the tenant for the current transaction. Returns NULL when unset, and a
-- NULL comparison yields no rows — so an unscoped request sees nothing rather
-- than everything. Fail closed, never open.
CREATE OR REPLACE FUNCTION current_school_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::bigint;
$$;

-- A platform operator bypasses tenancy, but only when explicitly elevated for
-- that transaction, and every such access is written to audit_log.
CREATE OR REPLACE FUNCTION is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.platform_admin', true), 'off') = 'on';
$$;

-- ── Policy applied to every school-scoped table ─────────────────────────────
DO $$
DECLARE
  t text;
  scoped_tables text[] := ARRAY[
    'academic_sessions', 'terms', 'class_levels', 'departments', 'classes',
    'subjects', 'users', 'staff', 'staff_assignments', 'students',
    'enrollments', 'student_subjects', 'guardians', 'guardian_student',
    'exam_series', 'passages', 'question_sets', 'questions', 'question_options',
    'question_vault'
  ];
BEGIN
  FOREACH t IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    -- FORCE applies the policy to the table owner too. Without it, anything
    -- running as owner quietly ignores every policy below.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (school_id = current_school_id() OR is_platform_admin())
        WITH CHECK (school_id = current_school_id() OR is_platform_admin())
    $f$, t);
  END LOOP;
END $$;

-- ── schools itself ──────────────────────────────────────────────────────────
-- A school may read only its own row. Listing every school is a platform-admin
-- action, and the hostname lookup that happens before authentication runs as a
-- separate, deliberately narrow role.
ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON schools;
CREATE POLICY tenant_self ON schools
  USING (id = current_school_id() OR is_platform_admin())
  WITH CHECK (id = current_school_id() OR is_platform_admin());

-- ── audit_log: append-only ──────────────────────────────────────────────────
-- Revoking UPDATE and DELETE is what makes the trail trustworthy. An audit log
-- the application can rewrite proves nothing.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_insert ON audit_log;
CREATE POLICY audit_insert ON audit_log FOR INSERT
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

DROP POLICY IF EXISTS audit_read ON audit_log;
CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (school_id = current_school_id() OR is_platform_admin());

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
-- Also revoke from the application role explicitly once it exists:
--   REVOKE UPDATE, DELETE ON audit_log FROM educbt_app;

-- ── sessions ────────────────────────────────────────────────────────────────
-- Not school-scoped: the session is looked up BEFORE the tenant is known.
-- Protected instead by an unguessable primary key and by expiry.
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
