# Production & Pilot Runbook — EduCBT

Operational runbook for the EduCBT production deployment and pilot. Written
against `main` @ `1fe7094` (2026-09-14). No credentials or secret values appear
in this document — variable *names* only.

- **Agent 1 (this document):** deployment + pilot readiness.
- **Agent 2 (separate):** load testing, release hardening, cutover validation.

---

## 1. Production architecture (as deployed)

| Layer | Provider | Detail |
|---|---|---|
| App hosting | Vercel | Next.js, `vercel.json` → framework `nextjs`, region `dub1` (intentional: closest Vercel region to Neon London) |
| Database | Neon | PostgreSQL 18, **London** |
| DB runtime credential | `educbt_app` | Least-privilege role, pooled (`-pooler`) endpoint, `sslmode=verify-full`, RLS mandatory (verified fail-closed) |
| DB admin credential | owner | DIRECT (non-pooler) endpoint — migrations/admin only, never runtime |
| Background jobs | Inngest Cloud | `/api/inngest` — signed with `INNGEST_SIGNING_KEY`; jobs: expired-attempt sweep (1/min), session purge (hourly), email drain (5/min) |
| Rate limiting | Upstash Redis REST | login throttle — fails OPEN when unset (a limiter must never block an exam) |
| Email | Resend | transport for the queued notification drain |
| Object storage / backups | Firebase (GCS) | nightly `pg_dump` via GitHub Actions, private bucket |
| Platform domain | `educbt.com` | schools resolve as `<subdomain>.educbt.com`; the bare platform host (no school) serves platform-admin sign-in |

**Database safety contract (never break):**
- Runtime uses **`DATABASE_URL_APP` only** (RLS applies).
- `DATABASE_URL_UNPOOLED` (owner) is for migrations/tooling only — enforced by
  `src/db/connection.ts` + `npm run test:config`, and by production-verify.
- Production connections require `sslmode=verify-full` (unverified TLS is
  refused by preflight).

---

## 2. Production URLs

- Application root / platform admin sign-in: the platform host (bare
  `educbt.com` or the current Vercel production domain until DNS is cut over) —
  a hostname that resolves to **no** school serves platform sign-in mode.
- Pilot school: `<subdomain>.educbt.com` (chosen during onboarding, §7).
- Inngest endpoint: `https://<production-domain>/api/inngest`
- Public transcript verification: `https://<production-domain>/verify/transcript`
- Inngest dashboard: https://app.inngest.com
- Neon dashboard: https://console.neon.tech
- Vercel dashboard: https://vercel.com

> ⚠️ Confirm the exact production domain in the Vercel dashboard (Project →
> Domains) and, once set, the same domain must be allow-listed as the Inngest
> app endpoint (§5).

---

## 3. Environment-variable checklist (names only — never values)

### 3.1 Vercel — required at build/runtime (app FAILS CLOSED without them)
| Variable | Notes |
|---|---|
| `DATABASE_URL_APP` | Pooled `educbt_app` endpoint + `sslmode=verify-full`. The ONLY runtime credential. |
| `PLATFORM_DOMAIN` | `educbt.com` |
| `INNGEST_SIGNING_KEY` | From Inngest dashboard → Environment → Keys. Without it, production `POST /api/inngest` returns **503** (fail-closed by design). |
| `TRANSCRIPT_VERIFY_SECRET` | Signs printed QR codes; the public verify page shows "unavailable" without it. Set once, never rotate casually. |

### 3.2 Vercel — required for enabled integrations
| Variable | Notes |
|---|---|
| `RESEND_API_KEY` + `MAIL_FROM` | Email drain. Without BOTH, the drain job reports `skipped` and emails stay queued (a pilot school without email is a supported state — the queue is the record, and the principal can drain manually). |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Login throttle. Optional; when unset the limiter fails open and only DB-level account lockout remains. |

### 3.3 Vercel — must NOT be set in production
| Variable | Why |
|---|---|
| `DATABASE_URL` | Dev fallback only — in production the app requires `DATABASE_URL_APP` and never reads this. Do not set it. |
| `DATABASE_URL_UNPOOLED` | Owner credential. Scripts/migrations only — never expose it to the app runtime. |
| `INNGEST_DEV` | Switches the SDK to a local dev server. Must be unset. |
| `INNGEST_EVENT_KEY` | Not needed — the app only *receives* scheduled work; no outbound events yet. |

### 3.4 GitHub repository secrets (already configured — used by Actions, not by the app)
`DATABASE_URL_UNPOOLED`, `EDUCBT_APP_PASSWORD`, `DATABASE_URL_APP`,
`BACKUP_DATABASE_URL`, `FIREBASE_STORAGE_BUCKET`, `FIREBASE_PROJECT_ID`
(+ Workload Identity Federation for GCS — no service-account JSON stored),
`RESTORE_DATABASE_URL` (restore rehearsal target), `PG_MAJOR` = `18`
(repository *variable*).

### 3.5 Local-development only
`DATABASE_URL` (fallback), `INNGEST_DEV=1`, `CA_TEST_HTTP_URL`,
`BACKUP_LOCAL_DIR`, `RESTORE_DATABASE_URL` (local rehearsal DB),
browser module/exe overrides for test suites.

---

## 4. Deployment process (Vercel)

The project auto-detects Next.js. Repository config is complete:
`vercel.json` (`framework: nextjs`, `regions: ["dub1"]`), `engines.node >= 20`,
build `next build`, install `npm ci` (Vercel uses the lockfile). **No repo-side
changes needed.**

Dashboard verification checklist (Settings → General):
1. Framework preset: **Next.js**
2. Production branch: **main**
3. Node version: 22.x (matches `engines`)
4. Region: **dub1** — intentional (Neon London proximity). Do not change
   without an owner decision.
5. Build command: `next build` (default), Output: default (`.next`)
6. Serverless compatibility: app uses only `force-dynamic` routes + the
   Inngest webhook route — no edge/runtime config conflicts.

Deploy: push to `main` (or redeploy from dashboard). Post-deploy checks §6.

---

## 5. Inngest production

**What is required:** one Inngest Cloud project (do not create more than one)
and its **signing key** in the Vercel env (`INNGEST_SIGNING_KEY`).

**Manual setup (recommended — fewest moving parts):**
1. Sign up / log in at https://app.inngest.com → **Create project** (e.g. `educbt`).
2. Copy **Production → Env → Keys → Signing key**.
3. Set `INNGEST_SIGNING_KEY` in Vercel (Project → Settings → Environment
   Variables → Production) and redeploy.
4. In the Inngest dashboard → **Apps → Add endpoint**:
   `https://<production-domain>/api/inngest` — production env only.
5. Registration succeeds automatically: the serve handler registers
   `sweep-expired-attempts`, `purge-expired-sessions`, `drain-email-queue`
   with their cron schedules (`* * * * *`, `0 * * * *`, `*/5 * * * *`).

**Vercel marketplace integration (alternative):** the official Inngest
integration injects `INNGEST_SIGNING_KEY` (and an event key) into the Vercel
project and **auto-registers the endpoint on every deploy**. Choose ONE path —
if you connect the integration, remove any manually-set signing key first so
they cannot disagree.

**Verify:** Inngest dashboard → Functions shows all three functions
"running" on schedule; recent runs are green. POST to `/api/inngest` without
a valid signature is rejected (503/401) — you can confirm with curl — no
unauthenticated trigger exists.

**No event key is needed today** (app only receives scheduled work).

---

## 6. Post-deploy smoke checklist (narrow, non-destructive)

Run once per production domain change, in order. Stop at the first failure.
| # | Check | Pass criterion |
|---|---|---|
| 1 | App root loads | platform sign-in mode on the bare host |
| 2 | `/verify/transcript` | page renders (not a server error) |
| 3 | Platform admin signs in (after §7 bootstrap) | dashboard loads |
| 4 | `/platform` school creation flow | see §7 |
| 5 | Principal sign-in at `<subdomain>` host | forced password change → portal |
| 6 | Principal dashboard, settings page | render; settings save round-trips |
| 7 | Staff creation, student creation | via portal UI |
| 8 | Question, paper, timetable creation | via portal UI |
| 9 | Student exam entry → answer autosave → submit | one candidate, one sitting |
| 10 | CA/result flow → report-card access | one subject, one student |
| 11 | Parent/guardian access | invite → sign-in → view result |
| 12 | Notification appears + (if Resend configured) one email to ONE test recipient | queue drains, no bulk send |
| 13 | Inngest dashboard | three functions scheduled and green |

Load testing is Agent 2's scope — do not stress production here.

---

## 7. First production school (platform onboarding)

**Bootstrap the FIRST platform account (one-time):**
- Option A (local, recommended): run
  `npm run bootstrap:platform-admin` with `DATABASE_URL_UNPOOLED` (Neon DIRECT
  owner endpoint, `sslmode=verify-full`) in the environment. It prints the
  one-time temporary password — capture it, then sign in on the platform host
  and let the forced password change take effect.
- Option B: dispatch a temporary GitHub workflow that runs the same script and
  prints the password into the Actions log (visible to repo admins only,
  masked by the script). Remove the workflow after use.
- Never create the platform user by direct SQL.

**Create the pilot school (application workflow, not SQL):**
1. Sign in as platform admin on the bare host → `/platform`.
2. Create school → unique code, subdomain (reserved-list validated), name.
3. Create its first Principal in the same transaction — the UI shows the
   temporary password **once**; hand it over over a secure channel.
4. The principal signs in at `<subdomain>.educbt.com`, is forced to change
   the password, then configures: school settings, session/term, staff,
   students.
5. Audit trail: every step is audited; suspension/reactivation are confirmed
   platform actions.

If no real pilot school is chosen yet, create a clearly identifiable pilot
school (code `PILOT01`, name prefixed "PILOT —") and record that it can be
suspended via `/platform` (soft) — data is retained by design for audit;
deletion is a separate owner decision.

---

## 8. Migration process (production DB)

State as of 2026-09-14: **all 17 migrations (0000–0016) applied and verified**
by `verify-production-db.yml` (green): tenant isolation, audit immutability,
RLS forced on every public table, `educbt_app` confirmed non-superuser
without BYPASSRLS over the pooled endpoint.

Standard incremental migration (the intended path for future migrations):
1. Migration files land in `drizzle/` via PR; CI runs the full baseline.
2. Dispatch **`init-production-db`** with input `continue=true`
   (it skips ONLY the empty-schema gate; TLS/version/endpoint checks remain).
   It runs, in order: preflight → provision `educbt_app` (idempotent,
   password unchanged — same secret) → `db:migrate` (applies only pending
   migrations, then re-applies the idempotent `rls.sql`) → re-provision
   grants. **Every step is idempotent and safe to re-dispatch.**
3. Dispatch **`verify-production-db`** — fixtures → `db:verify`
   → guaranteed teardown. Green = production DB is correct.
4. No destructive migration is ever dispatched without explicit owner
   approval (migrations 0000–0016 are all additive; the preflight refuses
   a non-empty schema unless `continue` is explicit).

Rules: never reset the production database; never drop schema/tables/data;
migrations are files in git, never hand-edited against production.

---

## 9. Rollback process

- **Bad application deploy:** Vercel → Deployments → previous (green)
  deployment → **Promote to Production**. Instant, no DB involvement.
- **Bad migration (rare, owner-approved only):** migrations are
  forward-only by design. If a forward fix is impossible, restore from backup
  into a rehearsal database first (§10), rehearse the rollback, then decide.
  Never roll production back by editing applied migrations.
- **Inngest failure:** functions fail visibly in the dashboard and retry;
  the underlying services are idempotent (double sweep/purge/drain = no-op).
  A failing drain leaves rows queued — no mail is lost, none is duplicated.

---

## 10. Backup / restore

- **Backup (nightly, already live & green):** `nightly-backup.yml` runs
  `npm run backup:db` on schedule — privileged `pg_dump` (`BACKUP_DATABASE_URL`,
  never the RLS app role) → Firebase/GCS private bucket, age-based retention
  (default 30 days), unrelated objects untouched. Success is visible nightly
  in the Actions tab (green as of 2026-09-14).
- **Verify storage access anytime:** dispatch `firebase-storage-verify.yml`
  (read-only; does NOT need the database URL).
- **Restore:** `npm run restore:db` (`scripts/restore-database.ts`) — the
  target must be a SEPARATE database (the live app DB is refused outright);
  non-local targets require an explicit `--disaster-recovery` flag.
  Monthly rehearsal: dispatch `restore-rehearsal.yml` (green 2026-09-08).

---

## 11. Email (Resend) checks

1. Vercel env has `RESEND_API_KEY` + `MAIL_FROM` (§3.2) — domain verified in
   Resend (dashboard → Domains).
2. Chain: school event → `email_events` row (queued) → Inngest
   `drain-email-queue` every 5 min → Resend send → row marked sent.
3. Controlled test: trigger ONE notification to ONE known test recipient via
   the portal; confirm delivery and the queue row transitioning to sent.
   Never bulk-send in testing.
4. Failed delivery: row stays queued and retries on the next drain — verify by
   (deliberately) using an invalid recipient once in a test school, then
   correcting it; the queue self-heals.
5. Without keys: job logs `skipped`; principal can drain manually from the
   portal (queue remains the record).

---

## 12. Firebase checks

- Bucket: private; nothing public (the web API key is NOT a storage
  credential — never treat it as one).
- Write path: nightly backup objects (verified green nightly).
- Access path: service-side only (`@google-cloud/storage`); CI uses
  Workload Identity Federation; a bucket-scoped service-account JSON is an
  alternative but none is stored in GitHub — keep it that way.
- Photo/document upload path in the portal uses the same server-side
  adapter (guardian photos, question images).
- Re-verify anytime: dispatch `firebase-storage-verify.yml`.

---

## 13. TOTP pilot policy (recommended)

TOTP is implemented (enrollment at `/portal/account/security`; RFC 6238;
lockout budget shared with wrong passwords) but **globally enforced for
nobody** — by design, so day-one principals are not locked out.

Recommended pilot policy:
- **Required:** platform admin account, and the pilot school's Principal.
- **Optional (recommended):** Vice Principal.
- **Rationale:** these accounts alter published results and school
  configuration; a shared staffroom password alone must not be enough.
- **Enforcement mechanism when the pilot office decides:** per-school config
  gate at the **capability check** (publish/approve), not a global sign-in
  wall. No new architecture is needed — the gate point is already designed.
- **Support/recovery before requiring it:** confirm at least one enrolled
  second factor per required account; note that TOTP disable requires a valid
  current code (self-service), and that admin-assisted reset is an audited
  action. Keep the recovery procedure with the school office contact.

---

## 14. Known operational limits

- **Email is optional** — without Resend keys the queue holds mail safely;
  do not mistake `skipped` drains for data loss.
- **Inngest signing key absent = 503** on the webhook route — this is the
  fail-closed design, not an outage; fix by setting the key.
- **Rate limiter fails open** without Upstash — DB lockout still protects
  sign-in.
- **Sessions live 12h**; hourly purge + opportunistic purge keep the table
  small.
- **`educbt_app` is pooled through PgBouncer transaction mode** — DDL always
  goes through the direct endpoint (migrations via Actions only).
- **Transcript QR codes** verify only while `TRANSCRIPT_VERIFY_SECRET` is
  unchanged; rotating it invalidates previously printed sheets.

## 15. Incident checklist (first 15 minutes)

1. **What is the blast radius?** One school / all schools / platform.
2. **Vercel:** check latest deployment status; roll back the deploy (§9) if
   the timeline matches a release.
3. **Neon dashboard:** branch health, connection saturation, storage.
4. **Inngest dashboard:** any function failing? (sweep stopped = candidates
   can type past time — restart urgently.)
5. **Actions:** did `nightly-backup` run green last night? (restore posture)
6. **Sign-in wave?** Check Upstash throttle + DB lockouts (fail-open is by
   design; the lockout table will show it).
7. **Tenant isolation report:** dispatch `verify-production-db.yml` —
   its green/red answer covers RLS integrity in one shot.
8. Record everything in the audit trail before changing anything.
