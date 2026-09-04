# EduCBT

Multi-tenant school examination and academic records platform. Next.js 15, Postgres, Drizzle.

Migrating from the WordPress plugin + theme system. See the migration plan for the full phase sequence — this repository is **Phase 1: foundation**.

---

## Setup

### 1. Neon project

Create the project in **`eu-west-1` (Ireland)** or `eu-central-1` (Frankfurt).

**Benchmark both from a real Lagos connection before choosing. A Neon project cannot be moved between regions later.**

Then, in project settings:

- **Turn OFF scale-to-zero.** Cold starts run to ~2.6s at p95. A student waiting that long mid-paper is a support call; three hundred at 9 a.m. is an incident. Always-on compute is roughly $19/month and is a fixed cost of running examinations, not an optimisation to revisit.

Copy **both** connection strings — pooled and unpooled. They are not interchangeable:

| String | Host | Used by |
|---|---|---|
| Pooled | `...-pooler...` | The application. PgBouncer, transaction mode. |
| Unpooled | no `-pooler` | Migrations and DDL only. |

### 2. Application role

RLS does not apply to superusers or table owners. Running the app as the owner silently disables every policy while leaving them visibly in place — worse than having none.

Run once, as the owner:

```sql
CREATE ROLE educbt_app LOGIN PASSWORD 'a-strong-password';
GRANT USAGE ON SCHEMA public TO educbt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO educbt_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO educbt_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO educbt_app;

-- The audit trail must not be rewritable by the application.
REVOKE UPDATE, DELETE ON audit_log FROM educbt_app;
```

Point `DATABASE_URL` at `educbt_app`. Keep the owner credential for migrations only.

For local development there is a runnable version of the block above:

```bash
npm run db:provision-app-role   # creates educbt_app idempotently, same grants
```

It reads `DATABASE_URL_UNPOOLED` from the environment, creates the role with a
development password if absent, and never runs in the application itself —
provisioning is infrastructure, not runtime. If the role already exists with a
different password, reset it by hand (`ALTER ROLE educbt_app PASSWORD '...'`).

**Verification must use the app role.** `db:verify` reads `DATABASE_URL_APP` —
when it is unset it falls back to `DATABASE_URL`, and if that is the owner,
every tenant-isolation check fails *by design*: superusers and owners are exempt
from RLS, so verifying as them proves nothing. A local `.env.local` therefore
needs all three:

```bash
DATABASE_URL_APP=...         # the app role — what the app RUNS on
DATABASE_URL_UNPOOLED=...    # the owner, for migrations and test fixtures
DATABASE_URL=...             # dev-only fallback when DATABASE_URL_APP is unset
```

The runtime contract is enforced in code, not by convention
(`src/db/connection.ts`): **production boots only on `DATABASE_URL_APP` and
fails closed without it** — it never silently falls back to a possibly
privileged `DATABASE_URL`. `npm run test:config` regression-tests the
contract without a database.

### 3. Environment

```bash
cp .env.example .env.local
```

`.env.example` documents every variable in full. The matrix:

| Variable | Purpose | Dev | Production | Server-only |
|---|---|---|---|---|
| `DATABASE_URL_APP` | Runtime DB: pooled `educbt_app` role, RLS applies | Optional (falls back) | **Required — fails closed** | Yes |
| `DATABASE_URL` | Runtime fallback for local dev only | Optional | Never used by the runtime | Yes |
| `DATABASE_URL_UNPOOLED` | Migrations, DDL, provisioning, test fixtures | Required | Required (migration step only) | Yes |
| `PLATFORM_DOMAIN` | Root domain for subdomain resolution | Required | Required | No |
| `UPSTASH_REDIS_REST_URL` | Login rate limiting | Optional (fails open) | Strongly recommended | Yes |
| `UPSTASH_REDIS_REST_TOKEN` | Login rate limiting | Optional (fails open) | Strongly recommended | Yes |
| `INNGEST_SIGNING_KEY` | Signs every request Inngest makes to `/api/inngest` | Not needed (`INNGEST_DEV=1`) | **Required — fails closed** | Yes |
| `INNGEST_DEV` | Local dev-server mode (`npx inngest-cli dev`) | Optional | Never set | Yes |
| `BACKUP_DATABASE_URL` | Nightly pg_dump credential (owner/admin — never `educbt_app`) | Falls back to `DATABASE_URL_UNPOOLED` | **Required** (GitHub secret) | Yes |
| `FIREBASE_STORAGE_BUCKET` / `FIREBASE_PROJECT_ID` | Backup object storage (private Firebase Cloud Storage / GCS bucket) | Optional (`BACKUP_LOCAL_DIR` instead) | **Required** (GitHub secrets) | Yes |
| `GCS_BACKUP_CREDENTIALS_JSON` | Backup service-account key — GitHub secret only, never `.env` | Optional (local ADC) | Optional (CI mints ADC from it; replaced by Workload Identity Federation) | Yes |
| `BACKUP_RETENTION_DAYS` | Age-based retention window | Defaults to 30 | Defaults to 30 | Yes |
| `RESTORE_DATABASE_URL` | Restore target — separate DB only, never defaulted | For rehearsals | For rehearsals / DR only | Yes |

There are **no `NEXT_PUBLIC_` variables** — nothing secret ever reaches the
client bundle, and `test:config` scans the source tree to keep it that way.
Resend, SMS and Sentry appear in `.env.example` only as clearly-labelled
placeholders; they are not yet required and do nothing until their features
exist. Firebase Cloud Storage **is** integrated — server-side only, for the
backup layer above; the bucket is private and there is no public-URL code
anywhere. The browser Firebase SDK is not installed.

#### Production deployment flow

1. **Backup** — take a verified database backup first (see the backup
   section once automated backups exist; until then, `pg_dump` by hand).
2. **Migrate** — `DATABASE_URL_UNPOOLED` (owner credential):
   `npm run db:migrate`. Migrations never run from application startup —
   the app runtime holds no DDL credential at all.
3. **Verify** — `DATABASE_URL_APP` (app role): `npm run db:verify`. This
   proves the runtime role is not superuser, does not own tables, does not
   carry `BYPASSRLS`, and that tenant isolation actually holds.
4. **Deploy** — the application starts on `DATABASE_URL_APP` only. A
   misconfigured production environment fails at boot with a clear error,
   never degrades to owner credentials.
5. **Health check** — then decide rollback on evidence, not guesswork.

### 4. Migrate

```bash
npm install
npm run db:migrate     # schema, then RLS policies
```

### 5. Run

```bash
npm run dev
```

---

## Verifying tenant isolation

Do this before writing any feature code. If it fails, nothing built on top is safe.

```sql
-- As educbt_app, with no tenant set: must return 0
SELECT count(*) FROM students;

-- Scoped to school 1: must return only school 1's students
SELECT set_config('app.school_id', '1', false);
SELECT count(*) FROM students;

-- Scoped to a school with no rows: must return 0, never an error and never
-- another school's data
SELECT set_config('app.school_id', '999', false);
SELECT count(*) FROM students;
```

An unscoped query returning rows means the app is connecting as owner or superuser. Fix that before continuing.

---

## Rules this codebase enforces

**Never import `db` directly in feature code.** Use `forSchool(schoolId, tx => …)`. The tenant is set with `SET LOCAL`, which ends at COMMIT — and that matters, because PgBouncer hands the same connection to the next school's request.

**Correct answers never reach the browser.** When the exam engine lands in Phase 4, the paper endpoint returns question text and options only. `isCorrect` stays server-side. Test it with the network tab open during a mock sitting.

**Portal routes are dynamic.** `export const dynamic = 'force-dynamic'` on anything showing per-user data. A cached page served to the wrong student was the single worst bug in the old system, and Next.js will happily reintroduce it in one line.

**Marks are `numeric`, never float.** A rounding error on a report card destroys a school's trust permanently.

**Times are `timestamptz` in UTC**, rendered in `Africa/Lagos`.

---

## Backups and disaster recovery

Neon is owned by Databricks, who have shut down an acquired database product before. Unlikely to repeat, but "unlikely" is not a plan when a term of results is at stake. The backup layer below is **built, tested and rehearsed** — not a to-do.

### Provider decision (current architecture)

**Production object storage is Firebase Cloud Storage (Google Cloud Storage)**, project `educbt-a07ae`, private bucket `educbt-a07ae.firebasestorage.app`. Firebase Storage is GCS under the hood, so the server-side adapter uses `@google-cloud/storage` — no Firebase browser SDK, no Firestore, no Firebase web API key anywhere in the backup path. (The earlier R2/S3 adapter was fully removed; see "Storage abstraction" below.)

**Firestore is not used by EduCBT and stays that way.** PostgreSQL is the single authoritative application and academic datastore. The backup system never duplicates data into Firestore, and no school/user/exam/result documents exist there. If a future feature genuinely justifies Firestore, that will be a deliberate design decision — not a side effect of storage work.

### What exists

- **`npm run backup:db`** (scripts/backup-database.ts) — full-database `pg_dump` in PostgreSQL custom format (compressed, single file, integrity-checkable with `pg_restore --list`), uploaded to the **private** Firebase Cloud Storage bucket under `backups/database/YYYY/MM/DD/<backup-id>.dump`, size-confirmed, then age-based retention cleanup. Structured JSON result; a failed upload is a failed backup; retention never runs after a failure.
- **`npm run restore:db`** (scripts/restore-database.ts) — `--list` to enumerate backups, `--backup <id>` to download, integrity-check and `pg_restore` into a **separate** database, then verify the restored schema (relations, migrations, row counts, RLS policies) from inside.
- **`npm run test:backup`** — 63 regression checks: naming determinism, collision handling, retention boundaries (age-based, never count-based), foreign-object safety, environment validation, restore-target guards, credential hygiene (no password or URI ever reaches a pg_dump/pg_restore command line), and a GCS-adapter section against a deterministic fake of the SDK surface (upload/download/size/list/delete, prefix isolation, error propagation, missing/partial credentials, and a structural scan proving the store module contains no URL-signing or object-publicising code).
- **`.github/workflows/nightly-backup.yml`** — the scheduled production backup (GitHub Actions, 01:00 UTC / 02:00 WAT, off-peak before Nigerian school hours). Enabled on deploy day by adding the repository secrets below; it is deliberately inert until then and **fails closed** — missing credentials abort the job before any database is touched.

### Storage abstraction

Everything above the storage layer is provider-independent: the scripts, retention logic, naming, guards and tests only ever see the `BackupStore` interface (put / get / exists / size / list / delete). Two implementations exist: `GcsStore` (production) and `LocalDirStore` (dev/rehearsal). Swapping Cloudflare R2 for Firebase Cloud Storage was an adapter-only change — no backup, restore or retention logic changed — and a future storage migration is the same one-file concern.

### Security model

- `BACKUP_DATABASE_URL` is an owner/admin credential — RLS would silently turn an `educbt_app` dump into a partial backup, so backing up as the app role is **refused** (`readBackupEnv`).
- The bucket is private and the storage layer has **no public-URL code at all** — backups cannot be shared as links, only fetched by infrastructure credential. Browser clients have no route to `backups/database/**`; permissive Firebase Storage Rules are never relied on for backup access (see IAM below).
- Deletion is structurally confined to the `backups/database/` prefix and to objects our own naming produced. Anything else — newer backups, foreign files inside the prefix (school logos, student photos, exports that may later live in the same bucket), objects outside it — is never a deletion candidate.
- Restoring into the **live application database is refused outright**, flag or no flag. Non-local restore targets that do not look like rehearsal/staging require an explicit `--disaster-recovery` flag. `RESTORE_DATABASE_URL` has no default: a typo cannot reach production.

### IAM and authentication design

- The backup service account (suggested: `educbt-backup@educbt-a07ae.iam.gserviceaccount.com`) gets **bucket-scoped** permissions on `educbt-a07ae.firebasestorage.app` only — the practical minimum is `roles/storage.objectAdmin` bound to that one bucket (upload, read, list, read metadata, delete expired objects). No project-wide Owner/Editor/Firebase Admin, no Firestore permissions, no unrelated Firebase administration.
- The adapter authenticates via Google **Application Default Credentials**. In CI the `google-github-actions/auth` step mints ADC on the runner; locally `gcloud auth application-default login` (or the optional `GCS_BACKUP_CREDENTIALS_JSON` secret) does the same. The backup code never handles a private key itself.
- **Recommendation:** start with the restricted service-account JSON stored only in GitHub Secrets (simple, auditable, revocable in one click), then upgrade to **Workload Identity Federation / GitHub OIDC** — which removes the long-lived key entirely — by swapping two inputs in the workflow. Because the adapter speaks ADC either way, that upgrade touches **no application code**.

### Restore rehearsal (executed, not hypothetical)

The full chain was run end-to-end live (originally against MinIO over the S3 adapter; the provider-independent parts — naming, retention, guards, the entire pg_dump/pg_restore/RLS chain — are unchanged by the GCS adapter swap and are re-proven by the suite every run):

1. `pg_dump` of the dev database (177,045 bytes, 374 archive objects) → upload → size-confirmed.
2. A second run seconds later → distinct backup id, nothing overwritten.
3. Three seeded old backups (older than 30 days) plus two decoys (a foreign file inside the prefix, an unrelated object outside it) → a real backup run deleted exactly the three old backups, reported the foreign-in-prefix object, and left **both decoys untouched**.
4. Restore of the first backup into a freshly created empty database (`educbt_restore_rehearsal`): byte-exact download, 30 relations restored, 10 migrations applied, all row counts matching the source — **and all 34 RLS policies / 29 forced-RLS tables survived**.
5. `npm run db:verify` run against the restored database over the real `educbt_app` role: **all checks passed** — cross-tenant reads return nothing, cross-tenant writes are rejected, the audit log is immutable, and RLS is forced on every public table. A restored database is not just data-complete; it is policy-complete.

Re-run this rehearsal at least **once per term**, with a named owner. A backup you have never restored is a hope.

### Disaster recovery runbook

1. Provision a **clean, empty** PostgreSQL (same major version as production) and a fresh empty database.
2. `npm run restore:db -- --list` to find the backup; then `RESTORE_DATABASE_URL=<fresh-db> npm run restore:db -- --backup <id> --disaster-recovery`.
3. On a brand-new cluster the `educbt_app` role does not exist yet — pg_restore reports the missing-role ACLs as **warnings and continues**; then run `npm run db:provision-app-role` and `npm run db:rls` (idempotent — every policy is `DROP ... IF EXISTS` + `CREATE`).
4. `npm run db:verify` against the recovered database — it must pass completely before anything points at it.
5. Repoint `DATABASE_URL_APP` (and only then) and redeploy. The restore script refuses to touch the old live database throughout.

### Deploy-day checklist (production secrets)

GitHub repository secrets: `BACKUP_DATABASE_URL` (owner/admin Postgres URI), `GCS_BACKUP_CREDENTIALS_JSON` (the bucket-scoped backup service-account key — see IAM above; swap for Workload Identity Federation later), `FIREBASE_STORAGE_BUCKET` (`educbt-a07ae.firebasestorage.app`), `FIREBASE_PROJECT_ID` (`educbt-a07ae`). Set the repository variable `PG_MAJOR` to the production server's PostgreSQL major version. The workflow is scheduled and will not fire until it is on the default branch with secrets present — no risk of half-configured automation, and a missing credential fails the job loudly instead of skipping the backup.

### Billing posture

The Firebase project is on the Blaze plan. Design targets are economical by construction — one backup per night, 30-day retention, no duplicate uploads (deterministic ids), downloads only for rehearsals or real recoveries — and nothing is hard-coded against today's free-tier numbers. **Owner deployment task:** configure Google Cloud budget/billing alerts (console → Billing → Budgets) so an accidental cost is noticed in hours, not on an invoice.

### Why not Vercel Cron / a web endpoint

The backup needs `pg_dump`/`pg_restore` binaries and a writable filesystem; Vercel serverless functions ship with neither and their execution limits rule out database-scale dumps. GitHub Actions runners install `postgresql-client` cleanly, hold no persistent secrets, and clean up their own temp files. Inngest remains what it is here for: application-level jobs (session purge, attempt sweep) that belong to the app.

---

## Structure

```
src/
  db/
    schema/core.ts      schools, sessions, terms, levels, departments,
                        classes, subjects
    schema/people.ts    users, sessions, staff, students, enrollments,
                        guardians, audit_log
    rls.sql             Row-Level Security policies
    index.ts            forSchool() — the only sanctioned way in
    migrate.ts          migrations + RLS
  lib/
    auth/password.ts    Argon2id
    auth/throttle.ts    login rate limiting and lockout
    tenant.ts           hostname → school
```

---

## Verification

```bash
npm run db:verify
```

Needs two connections, because RLS does not apply to owners or superusers —
running these checks as the owner would pass while proving nothing:

```
DATABASE_URL_UNPOOLED=postgres://owner@...     # fixtures
DATABASE_URL_APP=postgres://educbt_app@...     # the role RLS applies to
```

Fourteen checks, all verified against live Postgres 16:

```
PASS  app role is not a superuser
PASS  app role does not carry BYPASSRLS
PASS  app role does not own the tables
PASS  unscoped read returns nothing (fails closed)
PASS  scoped read returns only that school
PASS  a second school cannot see the first
PASS  unknown tenant returns nothing
PASS  cross-tenant write is rejected
PASS  audit log cannot be updated
PASS  audit log cannot be deleted
PASS  all passwords are argon2id
PASS  RLS enabled on every core table
PASS  RLS is FORCEd (applies to the table owner too)
```

Run it after every migration and before every deploy. Seed a **second** school
first — isolation cannot be tested with only one tenant.

---

## Phase 2 — read-only mirror

Students (search, status and class filters), student profile, classes with
headcounts, subjects grouped by level, staff.

Everything is read-only by design. This phase runs beside WordPress so scoping
bugs surface where they cost an afternoon, not a term.

### Role scoping

```bash
npm run test:scope
```

RLS guards the tenant boundary. It does **not** guard the boundary within a
tenant — a teacher must not see students they do not teach, and that lives in
`src/lib/queries.ts`.

The failure mode there is silent and generous: a missing condition returns MORE
rows and nothing errors. So it is tested explicitly:

```
PASS  teacher has at least one assignment
PASS  the outsider class is NOT reachable by the teacher
PASS  teacher sees fewer students than the school holds  — 5 of 6
PASS  the outsider student is NOT in the teacher's result set
PASS  a teacher with no assignments reaches no classes
PASS  school-wide roles see the whole school
```

**A teacher with no assignments sees nothing, not everything.** Fail closed.

`/portal/staff` refuses on the server for anyone not school-wide. Hiding the nav
link is convenience; the route protects itself.

---

## Phase 3 — question bank (schema and paper boundary)

`exam_series`, `passages`, `question_sets`, `questions`, `question_options`.

### The scope key

A question set is identified by:

```
school, session, term, subject, level, department,
exam_type, series_id, waec_mode          NULLS NOT DISTINCT
```

Every column is load-bearing. Dropping any one merges two different papers into
one row — which is how, in the WordPress system, writing practice questions
silently filled the examination paper and creating a second set failed with
"could not start a question set".

Two NULL traps, both real, both caught by the tests:

- `series_id` is `NOT NULL DEFAULT 0`. Nullable would let duplicate terminal
  sets through, because Postgres treats NULLs as distinct.
- `department_id` **carries a foreign key** so it cannot use that trick — hence
  `NULLS NOT DISTINCT` on the index. Every junior subject has a NULL department,
  so without this the constraint allowed duplicates for most of the school.

### Answers never reach the browser

```bash
npm run test:leak
```

`src/lib/exam/paper.ts` is the only sanctioned path from question storage to a
candidate's screen. It returns `PublicQuestion`, a type with no field for
correctness, so an answer cannot ride along inside a `select *`.

```
PASS  payload has no isCorrect field
PASS  payload has no marking guide or explanation
PASS  payload has no approval state
PASS  control: a select-* WOULD leak (test can detect a leak)
PASS  a duplicate set is rejected even with a NULL department
PASS  scope index declares NULLS NOT DISTINCT
```

The **control** check matters: it proves a naive query *would* leak, so the
other assertions are known to be capable of failing. A test that cannot fail
proves nothing.

### All suites

```bash
npm run db:verify    # 14 — tenancy, audit, credentials, RLS coverage
npm run test:scope   #  6 — role scoping within a tenant
npm run test:leak    # 11 — answer exposure, scope key
npm run test:auth    # 25 — credentials, lockout, sessions, school suspension
```

---

## Phase 3 (continued) — authoring, approval, vault

### Submission rules

Paired submission applies to the **terminal examination only**. Objective and
theory go in together, so a teacher cannot hand in half a paper.

A CA test and a practice paper are objective by design — requiring a theory half
meant their submit button could never enable, which reads as a broken button
rather than a rule.

A practice paper is **never reviewed**. It is not scheduled and nothing rests on
the result, so a review cycle would be skipped or rubber-stamped. It is approved
on submission and available to students immediately.

### Review

The set's status is **derived from its questions**, never set independently, so
the two cannot disagree. A set showing "approved" while holding a question sent
back for revision is how a paper reaches the hall incomplete.

Sending a set back requires a reason of at least 10 characters. A rejection
without one is a rejection the teacher cannot act on.

### Vault

```bash
npm run test:vault
```

Questions cannot be recomputed from anything else. Results survived the
WordPress table-drop because they derive from scores; questions had no second
copy and were simply gone.

Snapshots are taken at submission and approval. The test simulates the real
failure — deletes every question and restores:

```
PASS  snapshot is complete (no question missing its options)
PASS  questions really were destroyed
PASS  question IDS are preserved (results still point at them)
PASS  the answer key survived
PASS  a second restore adds nothing
```

Two rules the WordPress version got wrong:

- **Question ids are preserved**; option ids are not. Papers reference questions
  by id, nothing references an option by id, and restoring original option keys
  collided with existing rows — surfacing as "duplicate entry for key PRIMARY".
- **A lossy snapshot is refused.** An objective question stored without its
  options is a question with no answer key, and that is only discovered at
  restore time, when the original is gone.

### All suites

```bash
npm run db:verify    # 14  tenancy, audit, credentials, RLS coverage
npm run test:scope   #  6  role scoping within a tenant
npm run test:leak    # 11  answer exposure, scope key
npm run test:auth    # 25  credentials, lockout, sessions, school suspension
npm run test:vault   #  8  snapshot and recovery
```

---

## Phase 4 — CBT engine

`exam_papers`, `paper_questions`, `attempts`, `attempt_answers`, `attempt_events`.

### Four rules

**1. Time is the server's.** `expiresAt` is computed at start and is the only
thing deciding whether an answer is accepted. A device clock can be wound back;
a closed laptop does not pause the examination. The client countdown is
presentation.

**2. One attempt per student per paper.** Enforced by a unique index. Starting
again resumes — it never restarts, because a restart silently discards the first
set of answers and the candidate finds out at results.

**3. Saving is idempotent.** A dropped connection leaves the browser unsure
whether the answer landed, so it retries. The save upserts on
`(attempt, question)`; three retries produce one row.

**4. Nothing tells the candidate whether they were right.** Not on save, not on
submit. A response echoing correctness turns the paper into an answer key.

### Question order is stored, not recomputed

Fixed at start and kept on the attempt, so a resume on another device shows the
same paper in the same order. Recomputing the shuffle would reorder the paper
mid-examination.

### Bookmarks are not integrity incidents

Two separate counters. Conflating them meant a careful candidate who bookmarked
four questions looked identical to one who left the exam window four times.

### Auto-submission

`sweepExpired()` closes attempts whose time has run out. The client cannot be
trusted to submit on expiry — the tab may be closed, the machine asleep, or the
timer tampered with.

```bash
npm run test:engine
```

```
PASS  attempt created with a server deadline
PASS  a second attempt is rejected (resume, never restart)
PASS  three retried saves produce ONE answer row
PASS  an elapsed attempt is past its deadline regardless of client time
PASS  an extension moves the deadline forward
PASS  bookmarks and integrity incidents are counted separately
PASS  a submitted attempt no longer accepts integrity events
```

### All suites

```bash
npm run db:verify    # 14  tenancy, audit, credentials, RLS coverage
npm run test:scope   #  6  role scoping
npm run test:leak    # 11  answer exposure, scope key
npm run test:vault   #  8  snapshot and recovery
npm run test:engine  # 16  attempt lifecycle, sitting windows
```

---

## Phase 3 UI — authoring and review

Question sets list, authoring screen, review queue.

The screens enforce the same rules as the service layer, because both call the
same functions. Nothing is checked only in the browser.

- **Instructions come before the question text** — the order a candidate reads
  them, and the order an author thinks in.
- **The correct option must be marked.** A question with no answer key cannot be
  marked, and that only surfaces after candidates have sat it.
- **A submitted set is locked.** Editing resumes only when the exam office sends
  it back, and the reason travels with it.
- **Sending back requires a reason** of at least 10 characters.
- **Snapshots on submission and approval**, so the work survives a table wipe.
- `/portal/review` **refuses on the server** for anyone not school-wide.

```bash
npm run test:authoring
```

```
PASS  a new set is a draft
PASS  every question is PENDING, never approved on write
PASS  a submitted set is no longer editable
PASS  a returned set is editable again
PASS  set status and question status agree
PASS  approval leaves a snapshot behind
```

### All suites

```bash
npm run db:verify       # 14  tenancy, audit, credentials, RLS coverage
npm run test:scope      #  6  role scoping
npm run test:leak       # 11  answer exposure, scope key
npm run test:vault      #  8  snapshot and recovery
npm run test:engine     # 10  attempt lifecycle
npm run test:authoring  #  9  authoring and review workflow
```

**56 checks, all against live Postgres 16.**

---

## Phase 4 UI — the exam room

`/exam/[paperId]` — the candidate's screen. Timer, palette, answer sync,
integrity reporting, submit.

### Sync, in three layers

1. **Local first.** The answer is written to `localStorage` and the UI updates
   immediately. A candidate must never wait on a round trip to see their own
   selection register — at 200ms from Lagos to Ireland that wait is the whole
   feel of the paper.
2. **Server sync**, straight away, with an idempotency key so a retry updates
   the same row.
3. **Retry queue** with backoff, and a flush when the browser comes back online.
   Nothing is ever resubmitted by hand.

The server stays the source of truth. `localStorage` is an emergency copy for a
dropped connection.

### The timer is display only

Rendered from a server deadline; the **server** decides whether an answer is
accepted. A candidate who changes their device clock changes what they see and
nothing else. `sweepExpired()` closes abandoned attempts regardless.

### Sync status is visible

`Saved` · `Saving…` · `Waiting for connection` · `Closed`. A student should
always know whether their work is safe. A `409` stops the retry loop rather than
hammering a closed paper.

### Integrity warnings are true

Right-click and tab-switch are reported to the server before the banner appears.
In the WordPress system the banner said "this has been recorded" and nothing
was — a warning the system cannot back up is worse than none.

### Answers still never reach the browser

The page maps options to `id, key, text` only. `grep -rn "isCorrect" src/app/exam
src/app/api/exam` returns nothing.

### Registration decides what appears

A paper is listed on a student's dashboard only for a subject they registered.
Being in the class is not enough.

---

## Phase 5 — composition, marking, compilation

### Composition (`src/lib/exam/compose.ts`)

Turns approved question sets into papers.

- **Only approved sets compose.** A draft in the pool is a paper containing
  questions nobody reviewed.
- **A short pool is named and skipped**, never silently shortened. Shortening
  gives one class twelve questions and another twenty, marked out of the same
  total.
- **Re-composing does not duplicate.** A school office will run it twice.

Scheduling lays papers across a sitting window. Two papers may share a slot for
different levels; never for the same level, because one class cannot sit two
subjects at once. Papers that will not fit are **named**, not dropped.

The sitting window is set at scheduling, not at series creation — the dates on a
series are the *question-submission* window, and a school does not know its
sitting dates until it has papers to schedule.

### Marking (`markingQueue`, `awardMarks`)

Written answers route to the teacher **assigned to that subject**. Marked scripts
leave the queue — a marked script reappearing is how a teacher loses an afternoon
re-marking.

A mark outside the question's range is rejected. Otherwise a typo becomes a
student scoring 105%.

### Compilation (`src/lib/exam/grading.ts`, `results.ts`)

`grading.ts` has **no database imports**, so a grading boundary can be proven
without standing up a database.

- **Grades are stored on the result row, not derived.** Deriving them would
  rewrite a report card issued last term the moment a school edits its scale.
- **Positions are ranked in one pass, after every total is known.** Ranking as
  results are computed gives a position based on however many students happened
  to be processed first.
- Equal totals **share** a position: 1st, 2nd, 2nd, 4th.
- **Practice never counts** towards a result.
- Results are **withheld until published**; staff can see them beforehand, so a
  mark can be checked before the school commits to it.

```bash
npm run test:results
```

```
PASS  75 is A1 · 74 is B2 · 40 is E8, a pass · 39 is F9, a fail
PASS  equal totals share a position
PASS  the position after a tie skips  — 1st, 2nd, 2nd, 4th
PASS  a mark above the maximum is rejected
PASS  draft sets are excluded from composition
PASS  an unpublished result is hidden from the student
PASS  the grade is stored on the row
PASS  one result per student per subject per term
```

### All suites

```bash
npm run db:verify       # 14  tenancy, audit, credentials, RLS coverage
npm run test:scope      #  6  role scoping
npm run test:leak       # 11  answer exposure, scope key
npm run test:vault      #  8  snapshot and recovery
npm run test:engine     # 10  attempt lifecycle
npm run test:authoring  #  9  authoring and review
npm run test:results    # 19  composition, marking, compilation
```

**75 checks, all against live Postgres 16.**

---

## The domain layer

`src/domain/academic.ts` — **no database imports, and none belongs there.**

```bash
npm run test:domain    # 44 checks, no Postgres, under a second
```

Totals, grading, ranking and the result lifecycle are the rules a school will
argue about. They should be provable on a laptop with no environment, because
that is exactly what a school will ask you to demonstrate.

### Grading context is preserved

A result stores `gradingScaleId` and `gradingScaleVersion` alongside the grade.
Without them a grade cannot be explained a year later, and a school that revises
its bands has no way to show last year's B3 was correct under the rules then in
force. Scales supplied out of order still grade correctly — an admin screen will
not sort bands for you.

### Ranking is policy, not algorithm

```ts
type RankingPolicy = {
  tiePolicy: 'competition' | 'dense' | 'ordinal';
  tiebreakers: Array<'exam' | 'ca' | 'none'>;
  rankIncomplete: boolean;
};
```

- **competition** — 1, 2, 2, 4. The Nigerian default.
- **dense** — 1, 2, 2, 3.
- **ordinal** — every position distinct, for prize lists.

Tiebreakers apply in order; `exam` ranks the better examination ahead where
totals match. **Incomplete results are excluded by default** — ranking a student
missing four subjects against a full cohort produces a position that means
nothing.

The policy in force is stored on the result, so a school switching mid-year does
not leave last term's positions unexplainable.

### Result lifecycle

```
DRAFT → COMPILED → REVIEWED → PUBLISHED → LOCKED
```

- **COMPILED** is staff-only and freely recompilable.
- **PUBLISHED** is what a family has seen. Taking a result back from it, or
  unlocking a closed term, **requires a written reason** that goes to the audit
  log.
- Compiled **cannot skip review** and publish directly.
- Score entry is **refused** once a term is published — changing a mark beneath
  a result a family has already read is what this prevents.

### All suites

```bash
npm run test:domain     # 48  pure rules, NO database
npm run test:config     # 13  connection contract — NO database
npm run db:verify       # 14  tenancy, audit, credentials, RLS coverage
npm run test:scope      #  6  role scoping
npm run test:leak       # 11  answer exposure, scope key
npm run test:vault      #  8  snapshot and recovery
npm run test:auth      # 25  credentials, lockout, sessions, school suspension
npm run test:engine     # 16  attempt lifecycle, sitting windows
npm run test:authoring  #  9  authoring and review
npm run test:results    # 38  composition, marking, compilation
npm run test:practice   # 20  practice area and the formal-feedback guard
npm run test:jobs       # 20  scheduled session purge and expired-attempt sweep
npm run test:print      # 24  printed documents
npm run test:backup     # 63  backup naming, retention, restore-target safety, GCS adapter — NO database
```

**315 checks. 124 of them need no database at all.**

Backup operations themselves (not part of the suite): `npm run backup:db`,
`npm run restore:db -- --list` — see "Backups and disaster recovery".

---

## Printed documents

```bash
npm run test:print
```

Requires `weasyprint` — pinned, because the rendered page count is what the
suite asserts: `pip install -r scripts/requirements-print.txt`
(WeasyPrint 69.0, pydyf 0.12.1). It renders report cards at several subject
counts and **counts the pages**.

This exists because the WordPress printing was never actually printed during
development. It looked right in a browser preview and produced report cards that
started halfway down a page, bled into the next, and left blank leaves behind.
Nobody found out until a school printed a class set.

**Two bugs in this stylesheet were caught by the script, not by review:**

- `position: absolute` on the document container. Out-of-flow content does not
  paginate, so a batch of three report cards printed on **one page**.
- The signature block spilling alone onto a nearly empty second page at sixteen
  subjects — doubling a school's paper for two rules and a name.
- Long subject names tripling every row's height. Auto table layout gave the
  Subject column ~292px; a realistic 92-character name wrapped to three lines,
  so twelve rows pushed the tail block onto a nearly empty second page. Fixed
  with a deliberate fixed-column layout: the number columns (oversized for
  "1/32") fund an 88mm Subject column, long names wrap to at most two
  readable lines, and single-line rows — the honest 19-subjects-one-page /
  20-subjects-two-pages boundary — do not move by a single pixel. The
  broadsheet keeps its own geometry untouched.

None of these were visible in a single-page preview.

```
PASS  9 subjects                 1 page
PASS  16 subjects                1 page
PASS  16 with 2 not ranked       1 page
PASS  24 subjects                2 pages
PASS  batch of 3 cards           3 pages
PASS  batch of 30, 16 subjects  30 pages
PASS  no blank page between cards
```

### The rules, and why

- **The browser's own print engine.** Never html2canvas — a rasteriser cannot
  paginate, and its output is a picture, so table rules and signature lines come
  out as whatever it manages to redraw.
- **Chrome is removed from flow**, not merely hidden. `visibility: hidden`
  leaves the element occupying space, pushing the document down page one.
- **Break BEFORE each sheet**, never after. `page-break-after: always` fires
  after the last sheet too, leaving a blank page at the end of every run.
- **`overflow: visible` on the sheet.** `overflow: hidden` clips everything past
  page one and looks fine on screen.
- **Borders in points, stated literally.** Widths in mm rounded to zero in some
  engines; colours in custom properties were dropped entirely.
- **`print-color-adjust: exact`**, or browsers strip backgrounds and a bordered
  table becomes floating text.
- **`thead { display: table-header-group }`** so headings repeat on page two.
  Without it, a long table's second page is unlabelled numbers.
- **`page-break-inside: avoid`** on rows, the summary and the signature block.

### NOT RANKED is stated

A result excluded for incompleteness prints *not ranked* in italics, never `0`
and never blank. A zero reads as last place; a blank reads as an oversight.

## Fixes in this pass

- **Ordinal ranking is deterministic.** When totals and every configured
  tiebreaker are equal, order falls back to **admission-number order, compared
  numerically** — `2026010009` precedes `2026010010`, and `99` precedes `100`.
  Lexicographic comparison is the fallback for non-numeric formats only.

  **The input-order independence test is permanent.** Ranking must never depend
  on database row order, so the same cohort is ranked in both input orders and
  the positions compared. Without it, two compilations of one term can disagree.
- **NOT RANKED is explicit** — `position: null`, `state: 'not_ranked'`,
  `reason: 'incomplete'`.
- **Score upserts carry the full academic context**: school, student, subject,
  session, term, component. The key previously omitted school and session; a
  conflict target narrower than the constraint silently updates the wrong row.
  Proven across all five axes.

### All suites

```bash
npm run test:domain     # 48  pure rules, NO database
npm run test:config     # 13  connection contract, NO database, NO secrets
npm run db:verify       # 13  tenancy, audit, credentials — as the app role
npm run test:scope      #  6  role scoping
npm run test:leak       # 11  answer exposure, scope key
npm run test:vault      #  8  snapshot and recovery
npm run test:engine     # 16  attempt lifecycle, sitting windows
npm run test:authoring  #  9  authoring and review
npm run test:results    # 38  marking, compilation, exam-office services
npm run test:practice   # 20  practice area and the formal-feedback guard
npm run test:auth       # 25  credentials, lockout, sessions, school suspension

9 database suites, **147 checks against live Postgres 16**.

npm run test:print      # 24 checks, real PDF rendering

**232 automated checks** (61 with no database: domain rules, print geometry,
connection contract) **+ 24 print checks**.
```

---

## Broadsheet

`/portal/broadsheet` — a whole class against every subject, landscape.

Subject **codes** in the column heads, not full names: fifteen full subject
names across a landscape page leaves no room for the marks.

`nr` marks a subject excluded for incompleteness; `–` marks a subject the
student does not offer. Both are stated rather than left blank, because a blank
cell reads as an oversight.

### Print regression suite — permanent

```bash
npm run test:print     # 24 checks, real PDF rendering
```

Boundaries, long content, NOT RANKED, realistic class batches, and the
broadsheet in landscape across multiple pages.

```
1 · 2 · 9 · 16 · 19 (portrait limit) · 20 · 24 · 40 subjects
long subject names · long student name · both together
2 not ranked · every subject not ranked
batches of 3, 10, 30, 45 · mixed batch
broadsheet 30x9, 30x15, 45x15 — landscape confirmed by page geometry
broadsheet spans pages · headers repeat on each page
no blank page between cards
```

**Two failures this expansion caught:**

- **20 subjects spills to two pages.** 19 is the honest portrait limit with the
  signature block attached. Recorded as measured rather than adjusted to a round
  number.
- **The header-repeat check was wrong, not the CSS.** The stylesheet uppercases
  headings, so a case-sensitive search for `Adm. No.` failed on *every* page and
  reported a repeat failure that did not exist. Found by printing what the pages
  actually contain. A test that fails for the wrong reason is worse than no test.

Headings are confirmed present on **every** page of a multi-page broadsheet, by
walking the rendered page boxes — not by trusting the CSS rule exists.


---

## Exam Office — questions to published papers

`/portal/exams` is the one path from approved questions to a paper a student can
sit. It replaces nothing — it sequences what already existed into the order a
school office actually works in.

- `/portal/exams` — the list: what is drafting, what is published, what paper
  each series produced.
- `/portal/exams/new` — create a series. The **question window** (when teachers
  may submit questions) is separate from the sitting window, which is set at
  scheduling, because a school does not know its sitting dates until it has
  papers.
- `/portal/exams/[seriesId]` — the workflow: availability → compose → schedule →
  publish, with an honest checklist of what is missing rather than a button that
  fails on click.

### Publish gates, enforced in the service layer

- **Publishing refuses** an examination with no papers, with unscheduled papers,
  or one already published. Each refusal is a named error, not a disabled button.
- **Scheduling refuses practice series** — practice has no timetable, by design.
- **Practice publishes without a window.** Practice papers ignore formal sitting
  windows entirely; `startAttempt` checks the window for examinations only. The
  regression tests pin this: a practice series with no window starts, a formal
  one without a window is refused.

### Transactions and the one-connection pool

The shared pool is `max: 1`. A function already inside a `forSchool` transaction
must not call a helper that opens its own `forSchool` — the inner call waits for
a connection the outer one holds, and hangs. `startAttempt` did exactly this to
`paperForCandidate`, and would have hung every paper start in production.

The pattern is `service(...)` for top-level callers and `serviceTx(tx, ...)` for
use inside another transaction (`paperForCandidate` / `paperForCandidateTx`).
When you add a service that calls another service, ask which one owns the
transaction first.

### Test fixtures live in their own schools

Suites that mutate data (the exam-office checks, and any future suite touching
attempts, results, publishing or scheduling) create their own school and clean it
up first, so no suite passes only because another ran before it, and reruns never
hit unique constraints. Production constraints — RLS, foreign keys, unique
indexes — are never weakened for tests.


---

## Practice papers — the student flow and its hard boundary

`/portal/practice` is the student-facing practice area, deliberately separate
from the dashboard's formal paper list: practice never counts towards results,
and the two mixed together invite a student to treat one as the other. The
page lists Available / In Progress / Completed practice, each derived
server-side from the same registration join the formal papers use.

Sitting a practice paper reuses the CBT engine untouched — `startAttempt`,
`saveAnswer`, `submitAttempt` — so resume semantics, answer retry and
server-owned timing are the ones the engine tests already pin.

### Feedback, and why the guard is in the service

`practiceFeedback` (`src/lib/exam/practice.ts`) is the only source of
question-level feedback, and it refuses, server-side:

- **formal examinations** — whatever the attempt's status, even submitted. The
  check runs before any answer data is read, so no route, page or future UI can
  reach a formal marking key through the practice path. A formal exam's score
  is published by the school through compilation, never handed over on exit.
- **unsubmitted attempts** — feedback mid-paper is an answer key by another name.
- **another student's attempt** (`not_yours`) and **another school's attempt**
  (`not_found` — the id scanner learns nothing, not even existence).

The payload is a dedicated `PracticeFeedback` type: per question the text, the
student's option, the correct option, correctness, awarded marks and the
explanation — and nothing else. No approval state, marking guide, moderation
metadata or vault fields; the practice suite asserts the serialised payload
contains none of them. `/portal/practice/[attemptId]/feedback` renders it as a
learner screen: score, percentage, correct/attempted, then question review.

Practice fixtures in `test-practice` live in a private school, seeded with real
argon2id hashes (db:verify scans every user in every school), and are deleted
in a `finally` block — rerun-safe, nothing durable left behind.

## Background jobs — Inngest

Two things in this system must happen even when nobody is clicking: an exam
attempt whose time ran out must close (a candidate cannot be trusted to
submit — the tab may be closed, the machine asleep, the timer tampered
with), and a session record must die once its token has expired. The CBT
engine always owned the first half — `sweepExpired(schoolId)` is the same
tenant-scoped auto-submit path a candidate would trigger. What was missing
was the *when*: a scheduler that runs it without a human in the loop.

Inngest is that scheduler. The design keeps the two halves separable — the
job services (`src/lib/jobs/`) are plain, provider-free functions the test
suite covers directly; `src/inngest/` is thin glue; `src/app/api/inngest/`
is the only surface the provider can reach.

### The two jobs

| Job | Cadence | What it does |
|---|---|---|
| `sweep-expired-attempts` | every minute | Enumerates **active schools** and runs `sweepExpired` inside each tenant's own RLS scope |
| `purge-expired-sessions` | hourly | Deletes `sessions` rows past `expires_at` — the scheduled counterpart of the sign-in opportunistic purge |

Cadence reasoning: server-authoritative deadlines only bite if the sweep is
at least as granular as a countdown, hence every minute — and one run sweeps
every active school, so cadence is per-deployment, not per-school (Inngest
cron supports 1-minute schedules; volume is ~44k runs/month). Sessions live
12 hours, so hourly is far below the lifecycle at ~744 runs/month.

### Security — no RLS bypass, no open endpoint

- **Enumeration without privilege**: the school list the sweep iterates is
  read as the least-privileged `educbt_app` role through the existing,
  deliberately narrow `hostname_lookup` policy — `FOR SELECT`, active
  schools only. A suspended school stops being swept the moment it stops
  resolving. No superuser, no `BYPASSRLS`, no owner credential anywhere in
  the job path.
- **Tenant isolation preserved**: each school's sweep runs through
  `forSchool(schoolId)` — the normal RLS-scoped path, not a bulk update.
- **The route is not an open "trigger maintenance" endpoint**: `serve()`
  cryptographically verifies the `x-inngest-signature` header (HMAC-SHA256
  over the body with `INNGEST_SIGNING_KEY`, plus a timestamp window). In
  production without the key the route fails closed — mutating verbs return
  `503` rather than serving unsigned traffic.
- **Session records stay opaque**: the purge deletes by expiry and returns a
  count; token digests never appear in logs or summaries.

### Failure, overlap, and retries

Both services are idempotent — a double sweep closes nothing (`submitAttempt`
treats a non-`in_progress` attempt as a no-op), a double purge deletes
nothing — so an overlapping, delayed or retried run is always safe. Both
functions also set `concurrency: 1`, so Inngest queues an overlapping run
instead of executing it alongside. A school whose sweep throws is recorded
in the run summary and the NEXT school still sweeps; the failure is visible
in the Inngest dashboard and the provider retries the run.

```bash
npm run test:jobs
```

```
PASS  session rows store the SHA-256 digest, never the raw token
PASS  both users’ expired sessions are deleted
PASS  the active session survives the purge
PASS  a password-revoked session is not resurrected
PASS  running the purge again is safe and finds nothing (empty workload)
PASS  the expired attempt is auto-submitted by the sweep
PASS  saved answers remain intact after closure
PASS  objective answers are marked (1 correct, 1 wrong)
PASS  the student cannot keep answering after closure
PASS  an already-submitted attempt is unchanged
PASS  a practice attempt past its own deadline closes the same way
PASS  a suspended school is not swept (active-only enumeration)
PASS  running the sweep again closes nothing (idempotent rerun)
```
*(20 checks in full.)*

### Running the scheduler locally

```bash
INNGEST_DEV=1 npm run dev            # terminal 1 — the app
npx inngest-cli@latest dev          # terminal 2 — the provider emulator
```

The dev server discovers the app, registers both functions (no credentials
needed in dev) and fires the crons on schedule — the every-minute sweep
appears within 60 seconds as structured `{"job":"sweep-expired-attempts"...}`
lines in the app log, with its per-school summary. Jobs can be inspected,
re-run and triggered manually from the dev server UI at
`http://127.0.0.1:8288`. Production: deploy normally (the route is already
public on `/api/inngest`), then set `INNGEST_SIGNING_KEY` from the Inngest
dashboard (Environment → Keys) and register the app there.
