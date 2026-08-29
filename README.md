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

### 3. Environment

```bash
cp .env.example .env.local
openssl rand -base64 32   # → AUTH_SECRET
```

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

## Backups — set this up now, not later

Neon is owned by Databricks, who have shut down an acquired database product before. Unlikely to repeat, but "unlikely" is not a plan when a term of results is at stake.

- Nightly `pg_dump` to Cloudflare R2, 30-day retention.
- **Restore rehearsal once per term**, into a Neon branch, with a named owner. A backup you have never restored is a hope.
- No Neon-specific extensions in the schema, so moving to any stock Postgres stays a weekend rather than a rewrite.

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

Twelve checks, all verified against live Postgres 16:

```
PASS  app role is not a superuser
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
npm run db:verify    # 12 — tenancy, audit, credentials
npm run test:scope   #  6 — role scoping within a tenant
npm run test:leak    # 11 — answer exposure, scope key
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
npm run db:verify    # 12  tenancy, audit, credentials
npm run test:scope   #  6  role scoping within a tenant
npm run test:leak    # 11  answer exposure, scope key
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
npm run db:verify    # 12  tenancy, audit, credentials
npm run test:scope   #  6  role scoping
npm run test:leak    # 11  answer exposure, scope key
npm run test:vault   #  8  snapshot and recovery
npm run test:engine  # 10  attempt lifecycle
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
npm run db:verify       # 12  tenancy, audit, credentials
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
npm run db:verify       # 12  tenancy, audit, credentials
npm run test:scope      #  6  role scoping
npm run test:leak       # 11  answer exposure, scope key
npm run test:vault      #  8  snapshot and recovery
npm run test:engine     # 10  attempt lifecycle
npm run test:authoring  #  9  authoring and review
npm run test:results    # 19  composition, marking, compilation
```

**75 checks, all against live Postgres 16.**
