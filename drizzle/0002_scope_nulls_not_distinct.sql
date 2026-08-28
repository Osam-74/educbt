-- The scope key must treat a NULL department as a VALUE, not as a wildcard.
--
-- Postgres treats NULLs as distinct in a unique index by default, so two sets
-- identical on every column but with department_id NULL — which is every junior
-- subject, since junior levels have no department — did not collide. The
-- constraint meant to prevent duplicate papers silently allowed them.
--
-- This is the same trap that made series_id NOT NULL DEFAULT 0. department_id
-- cannot use that trick because it carries a foreign key, so the index is
-- rebuilt with NULLS NOT DISTINCT (Postgres 15+) instead.

DROP INDEX IF EXISTS question_sets_scope_uq;

CREATE UNIQUE INDEX question_sets_scope_uq
  ON question_sets (
    school_id, session_id, term_id, subject_id,
    level_id, department_id, exam_type, series_id, waec_mode
  )
  NULLS NOT DISTINCT;
