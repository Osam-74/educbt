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
