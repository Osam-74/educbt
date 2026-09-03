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
--
-- Static statements, NOT a DO $$ … $$ loop: the same file must apply on any
-- Postgres regardless of whether PL/pgSQL is installed (it is not always
-- available on managed instances), and a static list reads better than
-- dynamic SQL anyway. Tables are listed explicitly so a new schema table
-- shows up as a MISSING policy here rather than being silently included by
-- a wildcard.
--
ALTER TABLE academic_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON academic_sessions;
CREATE POLICY tenant_isolation ON academic_sessions
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON terms;
CREATE POLICY tenant_isolation ON terms
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE class_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_levels FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON class_levels;
CREATE POLICY tenant_isolation ON class_levels
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE departments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON departments;
CREATE POLICY tenant_isolation ON departments
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON classes;
CREATE POLICY tenant_isolation ON classes
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subjects;
CREATE POLICY tenant_isolation ON subjects
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff;
CREATE POLICY tenant_isolation ON staff
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE staff_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON staff_assignments;
CREATE POLICY tenant_isolation ON staff_assignments
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE students FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON students;
CREATE POLICY tenant_isolation ON students
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON enrollments;
CREATE POLICY tenant_isolation ON enrollments
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE student_subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_subjects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON student_subjects;
CREATE POLICY tenant_isolation ON student_subjects
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardians FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON guardians;
CREATE POLICY tenant_isolation ON guardians
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE guardian_student ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_student FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON guardian_student;
CREATE POLICY tenant_isolation ON guardian_student
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE exam_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_series FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON exam_series;
CREATE POLICY tenant_isolation ON exam_series
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE passages ENABLE ROW LEVEL SECURITY;
ALTER TABLE passages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON passages;
CREATE POLICY tenant_isolation ON passages
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE question_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_sets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON question_sets;
CREATE POLICY tenant_isolation ON question_sets
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON questions;
CREATE POLICY tenant_isolation ON questions
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE question_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_options FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON question_options;
CREATE POLICY tenant_isolation ON question_options
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE question_vault ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_vault FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON question_vault;
CREATE POLICY tenant_isolation ON question_vault
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE exam_papers ENABLE ROW LEVEL SECURITY;
ALTER TABLE exam_papers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON exam_papers;
CREATE POLICY tenant_isolation ON exam_papers
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE paper_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_questions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON paper_questions;
CREATE POLICY tenant_isolation ON paper_questions
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attempts;
CREATE POLICY tenant_isolation ON attempts
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE attempt_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_answers FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attempt_answers;
CREATE POLICY tenant_isolation ON attempt_answers
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE attempt_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempt_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attempt_events;
CREATE POLICY tenant_isolation ON attempt_events
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE subject_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE subject_results FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON subject_results;
CREATE POLICY tenant_isolation ON subject_results
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

ALTER TABLE assessment_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_scores FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON assessment_scores;
CREATE POLICY tenant_isolation ON assessment_scores
  USING (school_id = current_school_id() OR is_platform_admin())
  WITH CHECK (school_id = current_school_id() OR is_platform_admin());

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

-- The hostname lookup happens BEFORE authentication, so no tenant context
-- and no platform-admin elevation exist yet — tenant_self can never match
-- and the sign-in page would resolve no school at all under the application
-- role. Deliberately narrow instead: SELECT only, the application role only,
-- and ACTIVE schools only. A suspended or archived school must not resolve;
-- the runtime also filters on status, so the two layers agree.
DROP POLICY IF EXISTS hostname_lookup ON schools;
CREATE POLICY hostname_lookup ON schools
  FOR SELECT
  TO educbt_app
  USING (status = 'active');

-- ── users: pre-auth lookups ─────────────────────────────────────────────────
-- Sign-in resolves an account before a tenant exists. School accounts are
-- found through forSchool() once the sign-in form supplies the school, so the
-- tenant_isolation policy covers them. Platform-admin accounts own no school
-- by definition (school_id IS NULL), so that predicate can never match them.
-- These two policies are the narrow bridge: application role only, SELECT and
-- UPDATE of platform-admin rows only, no writes to school accounts.
DROP POLICY IF EXISTS platform_admin_lookup ON users;
CREATE POLICY platform_admin_lookup ON users
  FOR SELECT
  TO educbt_app
  USING (role = 'platform_admin' AND school_id IS NULL);

-- WITH CHECK keeps the shape: a row cannot stop being a platform-admin row,
-- so this can never grant or demote roles — only the same-row fields
-- (lockout counters, password hash) are writable.
DROP POLICY IF EXISTS platform_admin_update ON users;
CREATE POLICY platform_admin_update ON users
  FOR UPDATE
  TO educbt_app
  USING (role = 'platform_admin' AND school_id IS NULL)
  WITH CHECK (role = 'platform_admin' AND school_id IS NULL);

-- A request presenting a session token must re-read its own user row on every
-- request, BEFORE the tenant is known: status, lockout and forced password
-- changes are what makes a suspended student lose access instantly. The
-- session's token is unguessable AND stored only as a hash; binding this
-- policy to the user id that the presented token actually references limits
-- the read to exactly one row. No GUC bound → no rows: fail closed.
DROP POLICY IF EXISTS session_user_lookup ON users;
CREATE POLICY session_user_lookup ON users
  FOR SELECT
  TO educbt_app
  USING (id = NULLIF(current_setting('app.session_user_id', true), '')::bigint);

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
