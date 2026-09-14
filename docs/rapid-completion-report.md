# Rapid Completion Queue — Final Status Report (Phases 1–7)

**Date:** 2026-09-13 · **Author:** Superagent (Base44) on behalf of Olamide Amusan
**Status:** ALL 7 PHASES COMPLETE · `main` is green · pushed to `origin/main` @ `d8145f5`
**Purpose of this document:** hand off the exact state of the EduCBT Next.js migration to any agent or developer who continues this work. No prior conversation context is needed — this is the single source of truth.

---

## Mission

Achieve feature parity between the legacy WordPress plugin **EduCBT Pro** and the **Next.js/Neon rewrite** (this repo), following the 7-phase Rapid Completion Queue. Standing constraints: capability-based access control (not role-only gating), Inngest for background tasks (no WP-Cron patterns, no JSON blobs), print-ready documents via browser-based PDF generation, high code quality throughout.

**Current verdict: PILOT-READY.** The platform can be deployed to a pilot school.

---

## Phase 1 — Promotion + Transcripts (`feat/promotion-transcripts`, merged as `a62ce2a`)

**What was built**
- Promotion lifecycle service: draft → review → committed → reversed, with batch commits, audit trail, and enrollment rollover to the next academic session.
- Transcript office: transcript requests, compilation from historical results, issuance of signed transcripts.
- Public verification: HMAC-signed verification codes + QR codes printed on issued transcripts; a public `/verify` page (no login) confirms authenticity without exposing tenant data.
- Migration **0014** (promotions, transcripts, issuance records), full RLS tenant isolation in `src/db/rls.sql`.
- Portal pages: promotion office, transcript office, issued-document print, public verify.
- QA suite `src/db/test-promotion.ts` — **37/37 checks**, covering lifecycle, audit trail, and RLS.

**Notable fix during QA:** a DB unique-constraint collision between draft and published promotion rows; batch-commit logic was reordered so side-effect checks don't fire against stale rows.

---

## Phase 2 — Communications & Notifications (`feat/communications-notifications`, merged as `5ccf728`)

**What was built** (legacy WordPress logic mapped to modern Next.js architecture)
- In-app notification inbox, school-wide announcements, tenant-scoped parent↔school messaging.
- Provider-independent **email event queue** — emails are queued as rows and drained by a background worker, so no code path ever depends on a specific SMTP/provider at request time.
- Migration **0015** (notifications, announcements, messages, email_events), RLS on all of them.
- QA suite `src/db/test-comms.ts` — **39/39 checks**.

---

## Phase 3 — Document / Parity Closure ⚠️ includes the RENAMING — read this

**The bug.** After merging transcripts (Phase 1), the print-QA suite caught a regression: the **Terminal Report Sheet** (legacy report card, which must match WordPress output pixel-for-pixel) started spilling onto a second page for roomy 9-subject sheets.

**Root cause.** The transcript print styles redefined the generic class names `.doc__summary`, `.doc__stat`, `.doc__key` — the **same class names the Terminal Report Sheet already styles**. Because the transcript block appears later in the file, CSS cascade order made the transcript's larger summary tiles and taller grading key silently override the legacy-tuned report card sizes.

**The fix — commit `889da6f`.** The transcript-specific classes were **RENAMED** to namespaced versions:
- `.doc__summary` → **`.doc__tr-summary`**
- `.doc__stat` → **`.doc__tr-stat`**
- `.doc__key` → **`.doc__tr-key`**

**Rule for the future:** any new document type added to the print stylesheet must use its own namespaced classes (`doc__<type>-*`), never redeclare generic `.doc__*` classes. The `.doc__*` namespace belongs to the Terminal Report Sheet and is parity-locked against the legacy WordPress rendering.

Verified with the full print test suite: both report types now render and print-fidelity tests are green.

---

## Phase 3b — School Settings integration + the MIGRATION RENUMBERING

School settings (staff signatures, remark ranges, grading-scale versions, report remarks) was developed in parallel on a separate branch, originally numbered migration **0014**. Because promotion/transcripts (0014) and communications (0015) merged first, the settings migration was **RENUMBERED to 0016** during integration (`809f41f`, merged as `2a94a3b`).

**Rule for the future:** migration numbers are sequence-critical. New migrations must start after the highest applied number. Current sequence: 0014 (promotions/transcripts) → 0015 (communications) → 0016 (school settings). Never renumber an already-applied migration.

Also fixed during this phase: report staff lookup (`reportStaff`) was made school-scoped so remark ranges resolve within the tenant even when staff IDs repeat across schools.

---

## Phase 4 — QR / Document Verification audit

Audited the verification features delivered in Phase 1 rather than building duplicates. Confirmed in place:
- HMAC signature on transcript verification codes (`TRANSCRIPT_VERIFY_SECRET`), tamper-evident.
- QR code on every issued transcript pointing to the public verify page.
- Verify page reveals only authentic/duplicate/rejected status — no tenant data, no login.

Parity with the WordPress plugin's "verify result" feature: achieved. No gaps found; no new code needed.

---

## Phase 5 — Operational Workflow Audit (`b040467`)

End-to-end cross-module audit of the real operational flow: configure school → session/term → classes/subjects → enroll students → enter CA scores → sit exams → compile results → review/promote → issue transcripts → notify parents.

`src/db/test-operational-audit.ts` — **29/29 cross-module checks**. Includes the compile-snapshot fix (automatic remarks from staff remark ranges resolve via school-scoped report staff).

---

## Phase 6 — Role Completeness (`d8145f5`)

`src/db/test-role-completeness.ts` — **25/25 checks**. Verifies every role reaches its whole office and nothing beyond it, using capability-based access control:
- Class teacher (with subject assignment): enters CA marks; **cannot** compile.
- Exam officer: enters + compiles school-wide; **cannot** publish.
- Principal: sole publisher / sign-off authority.
- VP academics: proposes promotions.
- Parents/guardians: see exactly their linked children's reports; refused every staff office.

Run with `npm run test:roles`.

---

## Phase 7 — Pilot Readiness Audit ✅ PASS

1. **Fresh-database migration:** all migrations apply cleanly from an empty database — 45 tables created, zero errors.
2. **RLS coverage:** every table has RLS enabled and forced, **except `sessions` — which is deliberate and documented in `src/db/rls.sql`**: the session lookup happens before the tenant is known, so it is protected by an unguessable primary key and expiry instead.
3. **Full QA battery: 22/22 suites green:**

| Suite | Result |
|---|---|
| test-auth | PASS — session contract holds |
| test-authoring | PASS |
| test-backup | PASS |
| test-ca | 59 PASS / 0 FAIL |
| test-comms | 39 checks PASS |
| test-config | PASS |
| test-dashboards | 21 PASS / 0 FAIL |
| test-engine | PASS |
| test-jobs | PASS — sessions expire, attempts close on schedule |
| test-leak | PASS — no answer leak |
| test-operational-audit | 29 cross-module PASS |
| test-people | 60 PASS |
| test-platform | PASS |
| test-practice | PASS — formal papers can't reach practice |
| test-promotion | 37 PASS |
| test-result-workflow | 75 PASS / 0 FAIL |
| test-results | PASS |
| test-role-completeness | 25 PASS |
| test-scope | PASS |
| test-settings | 50 PASS |
| test-timetable | 23 PASS |
| test-vault | PASS — a wipe is recoverable |

4. **Production build:** `npm run build` compiles clean with the least-privilege app-role credential. The build correctly **hard-fails** if `DATABASE_URL_APP` is unset — that guard is intentional: the owner/superuser credential bypasses RLS and must never run the application.
5. **Typecheck:** `tsc --noEmit` clean. Working tree clean. All work merged to `main` and pushed to `github.com/Osam-74/educbt`.

---

## How to run everything (for the next agent)

```bash
# Test database (local): DATABASE_URL_UNPOOLED = owner credential, DATABASE_URL_APP = educbt_app role
export DATABASE_URL_UNPOOLED='postgres://…owner…'
export DATABASE_URL_APP='postgres://educbt_app:…@…/educbt_ca_test'   # REQUIRED for app + build
export TRANSCRIPT_VERIFY_SECRET='…' AUTH_SECRET='…'

npx tsx src/db/migrate.ts        # apply migrations (0014→0016 included)
npm run db:rls                   # re-apply RLS policies (idempotent, fast path)
npx tsc --noEmit                 # typecheck
npm run build                    # production build (needs DATABASE_URL_APP)
npx tsx src/db/test-<suite>.ts   # any suite from the table above
```

Required env vars: `DATABASE_URL_UNPOOLED`, `DATABASE_URL_APP`, `AUTH_SECRET`, `TRANSCRIPT_VERIFY_SECRET`. Email is optional: with `RESEND_API_KEY` + `MAIL_FROM` set, the `drain-email-queue` Inngest job sends queued mail every 5 minutes; without them it reports `skipped` and rows stay queued (the queue is the record of what should have been sent).

## Architecture rules that must not regress

1. **Capability-based access control** — check capabilities, never role strings alone.
2. **Inngest** for all background work — no WP-Cron, no JSON blobs.
3. **Print fidelity** via browser-based PDF generation; `.doc__*` classes are parity-locked to the legacy report sheet — new documents use `doc__<type>-*` namespaces.
4. **Migration numbering is sequence-critical** — current head is 0016; append, never renumber applied migrations.
5. **RLS everywhere** except the documented `sessions` exception.
6. The app must only ever connect with `DATABASE_URL_APP` (least-privilege role); the owner credential is for migrations/RLS only, and the build enforces this.


---

## Addendum — completion-gap audit round (2026-09-14)

A fresh audit of shipped-vs-parity found three gaps, all closed on `main`:

### P0 — Theory questions in the CBT room (`1ad9516`)

The backend already accepted text answers (`saveAnswer`, idempotent) and served `type`/`imageUrl`, but the exam room rendered only option buttons. A candidate sitting a paper with theory questions saw no way to answer, so the theory marking queue could never fill. The room now renders a local-first textarea that syncs through the same retry queue (debounced 900ms, force-enqueued at submit), and question images render.

### P1 — Production email drain (`1822ae4`)

Rows queued into `email_events` but nothing in production ever drained them. New `src/lib/jobs/email-drain.ts` + Inngest job `drain-email-queue` (5-min cadence): enumerates active schools through the same narrow `hostname_lookup` RLS window as the exam sweep — no BYPASSRLS — and drains each through `forSchool()` with a Resend transport (plain fetch). Without credentials the run reports `skipped`; rows stay queued and the principal can still drain manually.

### P1 — TOTP two-factor (`d0ac4e3`)

The schema carried `totp_secret`/`totp_enabled` ("a shared staffroom password should not be enough to alter a result set") with nothing behind it. Built: RFC 6238 engine on `node:crypto` (`src/lib/auth/totp.ts`, RFC Appendix B vectors in `test-totp.ts`), enrollment lifecycle (`start` → disabled secret; `confirm` → valid code flips it on; `disable` → requires a valid current code), the sign-in gate in `credentials.ts` (wrong code burns the same lockout budget as a wrong password; missing code asks without burning), and the staff enrollment screen at `/portal/account/security`.

**Deliberately open decision:** hard-enforcing TOTP for publish/approve roles would lock out every existing principal on day one. Enrollment is live and staff-facing; per-school enforcement is a config decision for the pilot office. When the office decides, the gate belongs at the capability check, not at sign-in.

**Regression status after this round:** the FULL battery — all 22 suites — re-run and green (auth, totp (new, 37 checks), leak, vault, engine, authoring, results (75), practice, jobs, domain, people (60), print, config, backup, platform, dashboards, timetable, promotion (37), comms (41), settings (50), operational (29), roles (25)); `tsc --noEmit` and `npm run build` clean. Note: `test:promotion` AND `test:roles` both require `TRANSCRIPT_VERIFY_SECRET` in the environment — the roles suite now guards with a clear assertion instead of failing at the QR check.

## Addendum — Question Bank branch + CI baseline exit-hang fix (2026-09-14, `d7023bb`)

### Question Bank completion (`cc5c842`, merged to main)

Question collection controls and scoped authoring safeguards (the `codex-qbank-init` audit branch, verified against `e4eeebc`): collection open/close lifecycle, per-author scoping, and `src/lib/exam/authoring-validation.ts` / `src/lib/exam/collection.ts`. The branch had never survived CI — see below for why, and note it was never the branch's own code.

### The CI "hang" — root cause and fix (`8d88ed9`)

Two CI attempts cancelled at the 30-minute timeout with the promotion suite blamed. Artifact forensics proved the suite innocent: `promotion.log` was fully written (including teardown) at **+2 seconds**, yet the shell loop never printed `promotion: PASS` and never started the next suite. The stall was *after* the work:

- `src/db/test-promotion.ts` never closed its main-scoped postgres.js `owner` client (`max: 1`, no `idle_timeout`). A **passing** run left that pooled TCP socket open, which kept the Node event loop alive — `npm run` never returned, and the synchronous CI shell loop waited on it until the job timeout. (Failing runs returned instantly because the `catch` path calls `process.exit(1)` — which is exactly why every earlier failing local run "worked" and only green runs hung.)
- Same latent pattern in `test-comms.ts` and `test-role-completeness.ts` (both call `forSchool` through the `@/db` module singleton and had never been reached in CI; they would have stalled the loop the same way right after promotion).

Fixes: close main's owner at the end of `main()`; close the `@/db` singleton in cleanup for promotion/comms/roles (the `test-ca` `appClient.end()` pattern); per-suite `=== start ===` markers and `ANALYZE` after fixture setup in `baseline.yml`; `timeout-minutes: 30 → 60` so the tail suites are actually reachable.

**Regression status after this round:** the branch CI completed green — **all 34 suites**, including the ten that had never once run in CI before (promotion, comms, operational, roles, totp, settings-validation, settings, question-validation, question-bank, print, print69). Main CI green at `d7023bb`. The full battery now takes ~90 seconds of suite time; promotion specifically went from a 30-minute timeout to 1.4 seconds.

**Lesson for future suites:** a pooled postgres.js client without `idle_timeout` will hang any passing test process that forgets `await client.end()` — always close every client the suite creates, plus the `@/db` singleton if the suite imports it.
