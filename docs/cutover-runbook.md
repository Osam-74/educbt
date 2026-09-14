# EduCBT Production Cutover & Migration Runbook

**Document Version:** 1.0.0  
**Target System:** EduCBT (Next.js / Neon Postgres `aws-eu-west-2` London / Vercel `lhr1` / Firebase Storage)  
**Source System:** EduCBT Pro WordPress Plugin (`wp_educbt_*` MySQL tables)  
**Status:** PILOT & PRODUCTION HARDENED CUTOVER RUNBOOK  
**Authoritative Schema:** `src/db/schema/*.ts` (Current Drizzle Migration Head: `0016`)

---

## 1. Executive Summary & Strategy

This runbook defines the operational procedure for migrating legacy WordPress EduCBT Pro data into the rewritten EduCBT Next.js multi-tenant PostgreSQL platform. 

### Operational Constraints & Principles
1. **Zero Data Loss & Corruption:** Historical academic results, transcript audit trails, and report card figures must carry over with 100% precision. Floating-point arithmetic is strictly prohibited; score totals use `numeric(8,2)`.
2. **Strict RLS Tenant Isolation:** All target tables (except `sessions`) enforce Row-Level Security keyed on `school_id`. Data imported must pass RLS validation without cross-tenant leakage.
3. **No Migration Renumbering:** The target schema head migration is `0016`. Applied migrations must never be renumbered.
4. **Auth Hash Incompatibility:** WordPress phpass (`$P$B...` / MD5) password hashes cannot be directly converted to EduCBT's custom Argon2id hashes (`$argon2id$...`).
5. **Downtime Window:** Migration takes place during a planned maintenance window (e.g., 4-hour weekend window) where the legacy WordPress system is set to read-only/maintenance mode.

---

## 2. Legacy Source vs. Target Schema Entity Mapping

The table below outlines the mapping between legacy WordPress plugin structures and target EduCBT Drizzle PostgreSQL schemas (`src/db/schema/*.ts`).

| Entity | Legacy Source (MySQL / WP) | Target EduCBT Table (`src/db/schema/`) | Primary Key / Scope Mapping & Notes |
| :--- | :--- | :--- | :--- |
| **Schools / Tenants** | `wp_educbt_schools`, `wp_educbt_tenants` | `schools` (`core.ts`) | Maps `id`, `name`, `code`, `subdomain`, `custom_domain`, `logo_url`, `principal_name`, `settings` (JSONB). |
| **Users & Accounts** | `wp_users`, `wp_usermeta`, `wp_educbt_users` | `users` (`people.ts`) | Maps `login_id` (admission # / staff email), `school_id`, `role` (`userRole` enum). Password hash requires forced reset. |
| **Staff & Teachers** | `wp_educbt_teachers`, `wp_educbt_staff` | `staff` (`people.ts`) | Maps `school_id`, `user_id`, `staff_number`, `first_name`, `last_name`, `email`, `designation`, `status`. |
| **Staff Assignments** | `wp_educbt_staff_assignments` | `staff_assignments` (`people.ts`) | Maps teacher duties across `school_id`, `staff_id`, `level_id`, `subject_id`, `class_id`. |
| **Students** | `wp_educbt_students` | `students` (`people.ts`) | Maps `school_id`, `user_id`, `admission_number`, `first_name`, `last_name`, `gender`, `status`. |
| **Guardians / Parents** | `wp_educbt_guardians`, `wp_educbt_guardian_student` | `guardians`, `guardian_student` (`people.ts`) | Maps parent email, phone, name, and junction table linking to `student_id`. |
| **Academic Sessions** | `wp_educbt_academic_sessions` | `academic_sessions` (`core.ts`) | Maps `school_id`, `title` (e.g. "2025/2026"), `starts_on`, `ends_on`, `is_current`. |
| **Terms** | `wp_educbt_terms` | `terms` (`core.ts`) | Maps `school_id`, `session_id`, `title` (e.g. "First Term"), `position`, `is_current`. |
| **Class Levels & Depts**| `wp_educbt_class_levels`, `wp_educbt_departments` | `class_levels`, `departments` (`core.ts`) | Maps level hierarchy (`stage`, `level_order`) and department groupings. |
| **Classes (Arms)** | `wp_educbt_classes` | `classes` (`core.ts`) | Maps `level_id`, `department_id`, `arm` (e.g., "A", "Gold"), `display_name` ("SS1 Science A"). |
| **Subjects** | `wp_educbt_subjects_v2` | `subjects` (`core.ts`) | Maps `school_id`, `name`, `code` (e.g., "MTH-J"), `stage`, `category`, `is_compulsory`. |
| **Student Enrollments**| `wp_educbt_enrollments`, `wp_educbt_student_subjects` | `enrollments`, `student_subjects` (`people.ts`) | Maps historical class enrollment per session and subject registration. |
| **Question Sets & Bank**| `wp_educbt_question_sets`, `wp_educbt_passages` | `question_sets`, `passages` (`questions.ts`) | Maps question bank categories, passages/comprehension blocks, and set status. |
| **Questions & Options** | `wp_educbt_questions`, `wp_educbt_question_options` | `questions`, `question_options` (`questions.ts`) | Maps question stems, question type (`mcq`, `theory`), marks, option choices, and correctness. |
| **Exam Series & Papers**| `wp_educbt_exam_series`, `wp_educbt_exam_papers`, `wp_educbt_paper_questions` | `exam_series`, `exam_papers`, `paper_questions` (`questions.ts`, `attempts.ts`) | Maps exam scheduling, duration, access codes, and paper question pools. |
| **Attempts & Answers** | `wp_educbt_exam_attempts`, `wp_educbt_attempts`, `wp_educbt_attempt_answers` | `attempts`, `attempt_answers`, `attempt_events` (`attempts.ts`) | Normalizes monolithic legacy answer JSON blobs into discrete `attempt_answers` rows. |
| **CA & Exam Scores** | `wp_educbt_assessment_scores`, `wp_educbt_results` | `assessment_scores` (`scores.ts`), `subject_results` (`results.ts`) | Maps CA component marks, exam scores, total scores, grades, and teacher remarks. |
| **Promotions** | `wp_educbt_promotions`, `wp_educbt_promotion_batches` | `promotion_batches`, `promotion_decisions` (`promotion.ts`) | Maps historical promotion batches, decisions (`promoted`, `repeated`), and audit trails. |
| **Transcripts** | `wp_educbt_transcripts` | `transcripts` (`promotion.ts`) | Maps issued transcripts, serial numbers, HMAC signatures, and verification hashes. |
| **Settings & Remarks** | `wp_educbt_signatures`, `wp_educbt_remark_ranges` | `staff_signatures`, `staff_remark_ranges`, `report_remarks` (`settings.ts`) | Maps Principal/Teacher signature image URLs, automatic score remark ranges, and report remarks. |

---

## 3. Data Gaps & Auto-Migration Blockers

During the migration audit, six key data structures were identified that **CANNOT be migrated automatically/safely without transformation or operational intervention**.

### 3.1. Password Hashes (WP phpass / MD5 vs Argon2id)
* **The Problem:** WordPress uses Portable PHP Password Hashing (`phpass` `$P$B...`) or MD5 hashes. EduCBT mandates custom Argon2id hashing (`$argon2id$...`). Hashes are non-reversible and cryptographically incompatible.
* **Impact:** Inserting WP password hashes directly into `users.password_hash` causes all login attempts to fail.
* **Remediation Strategy:**
  1. Set `users.password_hash` to a secure, unmatchable random dummy hash string during import.
  2. Set `users.must_change_password = true` for all imported user accounts.
  3. Trigger an automated email/SMS welcome campaign with a time-limited password reset token link or initial temporary password (e.g. `SchoolCode-2026!`), forcing immediate password update upon first portal entry.

### 3.2. Legacy V1 Unlinked Freeform String Data
* **The Problem:** Legacy V1 tables stored relationships as freeform text strings (`students.class = 'JSS 1A'`, `questions.subject = 'Mathematics'`) instead of relational Foreign Key IDs.
* **Impact:** Typos, whitespace variances, or naming discrepancies (e.g. "JSS 1A" vs "JSS1 A") cause foreign key constraint violations or orphaned records in Next.js Postgres.
* **Remediation Strategy:**
  1. Execute a pre-import string normalization ETL script (`scripts/normalize-strings.ts`).
  2. Map legacy strings against a canonical look-up dictionary (`class_levels`, `departments`, `classes`, `subjects`).
  3. Unresolvable or ambiguous string references are written to a staging table (`staging_migration_exceptions`) for manual operator reconciliation before final import.

### 3.3. Monolithic JSON Answer Blobs
* **The Problem:** Legacy WP stored student exam submissions as raw JSON strings inside `wp_educbt_exam_attempts.answers`. EduCBT uses a normalized 1-row-per-answer model (`attempt_answers`).
* **Impact:** Corrupt, partially saved, or malformed legacy JSON blobs fail JSON parsing.
* **Remediation Strategy:**
  1. ETL parser unrolls JSON blobs into individual `attempt_answers` rows, matching option IDs via `migration_map`.
  2. If option IDs are missing (due to legacy deletion), the answer is stored in `attempt_answers.text_answer` with `awarded_marks` preserved from the legacy attempt total.
  3. Unparseable JSON blobs are flagged and logged in `legacy_unparseable_attempts` for audit reference.

### 3.4. Orphaned Records
* **The Problem:** Deleted students, staff, or questions in WordPress left orphan rows in legacy results (`wp_educbt_results`) and attempts (`wp_educbt_exam_attempts`).
* **Impact:** Postgres strict Foreign Key constraints (`ON DELETE RESTRICT` / `CASCADE`) reject orphan inserts and abort transactions.
* **Remediation Strategy:**
  1. Pre-import FK audit query isolates orphan records on MySQL.
  2. Valid historical results with missing student/subject references are attached to an archived placeholder record (e.g., `Archived Student ID 9999`) or archived in `legacy_orphaned_results`.

### 3.5. Local Filesystem Media Paths
* **The Problem:** WP media items (logos, student photos, teacher signatures, question diagrams) reside on local disk (`/wp-content/uploads/`). EduCBT runs serverless on Vercel without persistent disk storage.
* **Impact:** Broken image links across portal UI, report cards, and question papers.
* **Remediation Strategy:**
  1. Run an automated S3/Firebase uploader script (`scripts/upload-media.ts`) to transfer the entire `/wp-content/uploads/` directory to Firebase Storage / Google Cloud Storage.
  2. Replace local relative paths (`/wp-content/uploads/2025/08/logo.png`) with public CDN URLs (`https://storage.googleapis.com/...`) in the target database.

### 3.6. Multi-Role Capability Mapping
* **The Problem:** WordPress allowed users to hold multiple roles or capabilities in `wp_usermeta`. EduCBT enforces capability-based access control tied to a single primary `users.role` enum plus explicit `staff_assignments`.
* **Impact:** Inconsistent authorization state if roles are mapped 1:1 from WP user roles.
* **Remediation Strategy:**
  1. Assign the highest administrative role (`principal`, `vice_principal`, `exam_officer`, `teacher`) to `users.role`.
  2. Decompose teaching duties into explicit entries in `staff_assignments`.

---

## 4. Operational Step-by-Step Cutover Execution

```
+-----------------------------------------------------------------------------------+
|                            CUTOVER TIMELINE OVERVIEW                              |
|                                                                                   |
|  T-24 Hours          T-4 Hours           T-2 Hours           T-1 Hour      T-0    |
|  Pre-Cutover Backup  Freeze Window       Export & ETL        Import & RLS  DNS    |
|  & Dry Run           (WP Maintenance)    Transform           Validation    Switch |
+-----------------------------------------------------------------------------------+
```

### Step 1: Pre-Cutover Preparation & Backups (T-24 Hours)
1. **Reduce DNS TTL:** Reduce TTL on domain records (e.g., `school.edu.ng`) to 300 seconds (5 minutes) to ensure rapid propagation during switchover.
2. **Legacy WordPress Full Dump:**
   ```bash
   mysqldump --single-transaction --quick --routines --triggers \
     -h <wp_db_host> -u <wp_db_user> -p <wp_db_name> > educbt_legacy_precutover.sql
   ```
3. **Archive Media Files:**
   ```bash
   tar -czvf wp_uploads_backup.tar.gz /var/www/html/wp-content/uploads/
   ```
4. **Neon Target DB Readiness:**
   - Verify head migration `0016` applied cleanly on Neon production database.
   - Run RLS policy initialization: `npm run db:rls`.
   - Take a Neon PITR restore branch tag: `neon branch create precutover-backup`.

### Step 2: Freeze Window & Downtime Entry (T-4 Hours)
1. **Enable WordPress Maintenance Mode:**
   Place a `.maintenance` file in WP root or activate maintenance plugin to display a 503 maintenance page.
2. **Disable WP-Cron & External Writes:**
   Disable background jobs and verify zero active database connections:
   ```sql
   SHOW PROCESSLIST;
   ```
3. **Notify School Stakeholders:** Send notification to school principals and administrators that the planned cutover window is active.

### Step 3: Export & ETL Transformation Pipeline (T-3 Hours)
1. **Execute Extraction Script:** Extract legacy tables into staging JSON/CSV files:
   ```bash
   npx tsx scripts/extract-legacy-wp.ts --host=<wp_host> --db=<wp_db>
   ```
2. **Transform Data & Build ID Maps:** Run the transformation pipeline to build entity conversion maps (`legacy_id` -> `neon_id` stored in `migration_map`):
   ```bash
   npx tsx scripts/transform-etl.ts
   ```
3. **Upload Media Assets:** Upload uploads archive to Firebase Storage/GCS:
   ```bash
   npx tsx scripts/upload-media-to-gcs.ts
   ```

### Step 4: Strict Sequential Data Import Order (T-2 Hours)
Imports MUST be executed in strict dependency order to satisfy PostgreSQL foreign keys and RLS constraints:

```
 1. schools
 2. academic_sessions -> terms
 3. class_levels -> departments -> classes
 4. subjects
 5. users
 6. staff -> staff_assignments -> staff_signatures -> staff_remark_ranges
 7. students -> guardians -> guardian_student -> enrollments -> student_subjects
 8. question_sets -> passages -> questions -> question_options -> question_vault
 9. exam_series -> exam_papers -> paper_questions
10. attempts -> attempt_answers -> attempt_events
11. assessment_scores -> subject_results
12. promotion_batches -> promotion_decisions -> transcripts
13. grading_scale_versions -> report_remarks
```

Execute import script using owner credential (`DATABASE_URL_UNPOOLED`):
```bash
export DATABASE_URL_UNPOOLED='postgres://owner:pass@ep-prod.aws-eu-west-2.neon.tech/educbt?sslmode=verify-full'
npx tsx scripts/import-to-neon.ts
```

### Step 5: Post-Import Validation & RLS Isolation Check (T-1 Hour)
1. **Execute Integration Test Battery:** Run full automated test suite using the app role credential (`DATABASE_URL_APP`):
   ```bash
   export DATABASE_URL_APP='postgres://educbt_app:pass@ep-prod.aws-eu-west-2.neon.tech/educbt?sslmode=verify-full'
   npx tsx src/db/test-operational-audit.ts
   npx tsx src/db/test-role-completeness.ts
   ```
2. **Verify RLS Isolation:** Verify that an app connection scoped to `school_id = 1` cannot read records from `school_id = 2`.
3. **Check Orphan & Foreign Key Constraints:** Verify zero constraint violations:
   ```sql
   SELECT count(*) FROM students WHERE school_id NOT IN (SELECT id FROM schools);
   ```

### Step 6: Reconciliation & Spot Checks (T-30 Minutes)
1. **Row Count Audit:** Ensure row count parity between source and target:
   
   | Entity | MySQL Source Count | Neon Target Count | Difference / Status |
   | :--- | :--- | :--- | :--- |
   | Schools | 1 | 1 | 0 (PASS) |
   | Students | 450 | 450 | 0 (PASS) |
   | Staff | 35 | 35 | 0 (PASS) |
   | Questions | 2,400 | 2,400 | 0 (PASS) |
   | Subject Results | 12,500 | 12,500 | 0 (PASS) |

2. **Academic Aggregate Spot Checks:** Verify `SUM(total_score)` and `AVG(total_score)` per subject and class between legacy WP report cards and EduCBT Next.js.
3. **Terminal Report Card Pixel Check:** Load 5 sample student report cards on `/portal/reports/[studentId]` and verify layout, grades, positions, and signatures match WP output pixel-for-pixel.

### Step 7: DNS Switchover & Go-Live (T-0)
1. **Update DNS Records:** Point root/subdomains to Vercel production deployment:
   - CNAME `portal.school.edu.ng` -> `cname.vercel-dns.com`
   - A `@` -> `76.76.21.21`
2. **Verify Vercel SSL Certificate:** Confirm Vercel automatically issues Let's Encrypt TLS certificate for the custom domain.
3. **Verify Routing:** Confirm `schools.subdomain` and `schools.custom_domain` route to the correct tenant dashboard.
4. **Decommission WP Writes:** Configure legacy WP host to issue 301 Permanent Redirects to `https://portal.school.edu.ng`.

---

## 5. Emergency Rollback Procedure

If a critical failure occurs during cutover (e.g. unresolvable data corruption, RLS failure, or >0.1% score discrepancy), execute immediate rollback:

### Rollback Execution Steps
1. **Revert DNS:** Change DNS CNAME / A records back to legacy WordPress host IP address immediately.
2. **Re-Enable WP Writes:** Remove `.maintenance` file from legacy WordPress host and re-enable WP-Cron.
3. **Isolate Neon Database:** Wipe imported staging tables or restore Neon branch from `precutover-backup` PITR snapshot.
4. **Notify Team & Log Incident:** Document the specific failure cause (e.g. unhandled legacy schema edge case) in `docs/incident-log.md` and reschedule cutover window.

---
*End of Cutover Runbook.*
