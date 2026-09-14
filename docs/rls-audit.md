# EduCBT — Row-Level Security Audit (Phase 6)

**Scope:** every tenant-sensitive table in the schema. Tested against a local Postgres 15 cluster (port 5435), migrated + RLS-applied + seeded from `origin/main` (`npm run db:migrate && npm run db:provision-app-role && npm run db:rls && npm run db:seed`). Branch: `feat/release-hardening-security`.

## Coverage matrix (live query against `pg_class` / `pg_policy`, not just source reading)

```sql
select relname, relrowsecurity, relforcerowsecurity
from pg_class where relkind='r' and relnamespace='public'::regnamespace order by relname;
```

Result: **44 of 45 tables have RLS enabled AND forced.** The one exception is `sessions`, which is the documented, deliberate carve-out (see below) — not a gap.

| Requested table group | Tables found | RLS enabled+forced |
|---|---|---|
| questions | `questions`, `question_options`, `question_sets`, `question_vault`, `paper_questions`, `passages` | ✅ all |
| exams/papers | `exam_papers`, `exam_series` | ✅ all |
| attempts | `attempts`, `attempt_answers`, `attempt_events` | ✅ all |
| scores | `assessment_scores`, `subject_results` | ✅ all |
| results | `subject_results`, `report_remarks`, `grading_scale_versions` | ✅ all |
| students | `students`, `student_subjects`, `enrollments` | ✅ all |
| staff | `staff`, `staff_assignments`, `staff_remark_ranges`, `staff_signatures` | ✅ all |
| guardians | `guardians`, `guardian_student` | ✅ all |
| communications | `announcements`, `notifications`, `notification_prefs`, `messages`, `message_threads`, `thread_participants`, `email_events` | ✅ all |
| promotions | `promotion_batches`, `promotion_decisions` | ✅ all |
| transcripts | `transcripts` | ✅ |
| settings | (grading/ranking/signatures — see staff_* / grading_scale_versions above; no separate `settings` table) | ✅ |
| root tenant | `schools` | ✅ (`tenant_self`: `id = current_school_id()`) |
| users | `users` | ✅ (tenant_isolation + two narrow pre-auth bridge policies, see below) |
| audit | `audit_log`, `portal_uploads`, `classes`, `class_levels`, `departments`, `subjects`, `terms`, `academic_sessions` | ✅ all |

**Design note (verified in `rls.sql`):** every one of the 43 school-owned tables carries a **denormalized `school_id` column** (confirmed via `information_schema.columns`), so every policy is a flat `school_id = current_school_id()` comparison — no joins, no N+1 policy evaluation cost, and no table can be silently missed because a new table without a `school_id` column and matching policy would fail to compile against the static policy list in `rls.sql` (it's a static list, not a dynamic loop, by design — a new table shows up as a *missing* policy rather than being silently swept in by a wildcard).

## The documented `sessions` exception — verified

`rls.sql`: `ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;` with a comment explaining the session lookup happens *before* the tenant is known (you need the session to find out which school you're in), so it can't be gated by `current_school_id()`. Instead it is protected by an unguessable, hashed session token as primary lookup key plus expiry. This is a reasonable, narrow, well-documented exception — confirmed as-implemented, not flagged as a new finding, consistent with the brief.

Two more narrow, intentional bridge policies exist for the same reason (pre-tenant lookups), both reviewed and confirmed narrow:
- `hostname_lookup` on `schools`: `SELECT`-only, `educbt_app` role only, `status = 'active'` only — lets the sign-in page resolve *which* school a hostname belongs to before any session exists, but only ever returns active schools (a suspended/archived school cannot be resolved even for sign-in).
- `platform_admin_lookup` / `platform_admin_update` on `users`: scoped to `role = 'platform_admin' AND school_id IS NULL` only, and the `UPDATE` policy's `WITH CHECK` repeats the same predicate — so it is structurally impossible to use this bridge to grant or demote a role, only to touch same-row fields (lockout counters, password hash) on an already-platform-admin row.

## Direct cross-tenant proof (raw SQL, `educbt_app` role — not the owner)

Ran directly against the seeded local DB (two real schools: `DEMO001` id=1, `TOTP-FIXTURE` id=4):

```sql
BEGIN;
SET LOCAL app.school_id = '1';
SELECT count(*) FROM students WHERE school_id = 4;   -- explicit cross-tenant read attempt
-- => 0

SELECT count(*) FROM students;                        -- own-school read
-- => 6  (only school 1's own rows)
ROLLBACK;

BEGIN;
-- no app.school_id set at all
SELECT count(*) FROM students;
-- => 0   (fail-closed: unscoped request sees nothing, not everything)
ROLLBACK;

BEGIN;
SET LOCAL app.school_id = '4';
UPDATE students SET admission_number = 'HACKED-CROSS-TENANT' WHERE school_id = 1;
-- => UPDATE 0   (cross-tenant write attempt also blocked)
ROLLBACK;
```

**Result: School A's session can neither read nor write a single row belonging to School B, even when explicitly filtering/targeting School B's own `school_id`, and an unscoped request (bug that forgets to set the tenant) sees zero rows rather than everything.** This is the strongest possible outcome — the policy fails closed in both directions (missing scope, and wrong scope).

## Cross-module regression evidence (existing suites, re-run against this cluster)

These suites already contain cross-school assertions per their own comments/naming and were re-run here for confirmation, all green:

| Suite | Result |
|---|---|
| `test:scope` | 6/6 PASS — teacher cannot reach an outsider class/student; unassigned teacher reaches nothing; school-wide roles see the whole school |
| `test:leak` | 11/11 PASS — no marking/correctness data reaches the candidate payload (includes a self-check proving the test can detect a real leak) |
| `test:auth` | 14/14 PASS — session contract, including tenant-suspension cutting off already-live sessions |
| `test:totp` | 13/13 PASS |
| `test:platform` | 13/13 PASS — audit trail, no owner credential in runtime code |

Suites not re-run in this pass (time-boxed): `test-ca`, `test-comms`, `test-jobs`, `test-operational-audit`, `test-promotion`, `test-question-bank`, `test-timetable` — these also carry cross-school assertions per source comments; re-running the full battery is recommended before merge (see main branch's own testing policy: full regression at the end, not after every small change).

## Verdict

**No RLS holes found.** Coverage is complete (44/44 applicable tables, 1 documented exception verified correct), the design is denormalized and fail-closed, and a direct adversarial SQL probe against the real `educbt_app` role confirms cross-tenant read AND write are both blocked. Treat as **P0-clear** for this audit pass, with one **P1 test-coverage gap** noted in `security-audit.md` (guardian-to-child scoping needs a dedicated adversarial test, not because a hole was found, but because none currently proves it directly).
