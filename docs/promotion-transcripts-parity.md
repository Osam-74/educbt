# Promotion & Transcripts — Parity Report

Branch: `feat/promotion-transcripts` (pushed)
Status: **Complete.** Full battery green (19 suites, ~400 checks) + 19/19 browser QA.

## What the legacy plugin did (EduCBT Pro)

The WordPress plugin ran end-of-year promotion as a guarded workflow: a
principal proposes moving a level's students into the next session based on
configurable rules (pass mark, averages, core-subject requirements), reviews
the proposal student by student (with the ability to override a decision so
long as a written reason is recorded — "why was my child not promoted" must be
answerable from the record), commits it once, and can reverse a committed
promotion with a reason. Transcripts were issued per student with a serial,
printed, and later verified by a code printed on the document.

## What the Next.js platform now does

### Migration 0014 (`drizzle/0014_promotion-transcripts.sql`)
- `promotion_batches` — one proposal per level + from/to session, status
  `proposed → committed → reversed`, tenant-scoped.
- `promotion_decisions` — one row per student: proposed outcome, final
  outcome, average, subjects passed/offered, borderline flag, override
  reason, audit columns.
- `transcripts` — issued documents with serial, purpose, status
  (issued/revoked), and verification fields.
- Serial allocation and audit-trail tables; RLS policies enforce tenant
  isolation (verified by dedicated cross-tenant checks).

### Services (`src/lib/promotion/`)
- `proposePromotion` — evaluates a level against rules (`passMark`,
  `promoteAverage`, `trialAverage`, `minSubjectsPassed`, `requireCore`),
  producing promote / trial / repeat / graduate / unresolved decisions with
  borderline flags. Rejects a second open proposal for the same
  level+session.
- `overridePromotion` / `bulkOverridePromotion` — principal-only decision
  overrides; written reason mandatory.
- `commitPromotion` / `reversePromotion` — commit writes next-session
  enrollments (and graduates the graduates); reverse removes only what the
  batch wrote and reinstates. Both audited.
- `issueTranscript` / `revokeTranscript` — serial allocation, per-purpose
  issuance, revocation recorded for later verifications.
- HMAC verification (`src/lib/promotion/transcript.ts`) — the verification
  code on the document is a signed digest of serial + student + school, so
  the public verify page needs no session and leaks nothing.

### UI
- **Promotion office** (`/portal/promotion`) — rule form, batch list, review
  table with borderline highlighting, bulk review, commit and reverse with
  mandatory written reasons. Teacher/parent roles are redirected away
  (capability-gated, not role-string-gated).
- **Transcript office** (`/portal/transcripts`) — load student by admission
  number, issue per purpose, print from history, revoke with a reason.
- **Issued document** — print view with `print.css` parity: OFFICIAL COPY
  watermark, serial, verification code + QR; prints on exactly 1 page.
- **Public verify** (`/verify`) — code lookup, no auth; confirms genuine
  copies, refuses wrong/revoked ones, never reveals more than the verdict.

### Production bugs found and fixed by QA
1. **Sign-in crashed on the production build.** `headers()` inside the
   sign-in server action throws "outside a request scope" on Next 15.1.0
   production builds (dev mode masks it; every existing suite injects the
   session cookie directly, so form sign-in was never exercised against
   `next start`). Audit IP/user-agent now degrade to null instead of
   failing sign-in.
2. **Success banners showed `NEXT_REDIRECT`.** In the override / commit /
   reverse / issue / revoke actions the success `redirect()` sat inside the
   `try`, so its thrown sentinel was caught and re-shown as the error
   banner. Actions now compute a destination and redirect once, after the
   try/catch.

### QA evidence
- `src/db/test-promotion.ts` — 45 checks: lifecycle, audit trail, RLS
  (cross-tenant insert/read rejected), serial uniqueness, HMAC verify.
- `tmp-qa/promotion-qa.ts` — 19 browser checks over the production build:
  sign-in → propose → override → commit → issue → print (watermark, serial,
  code, 1 page) → public verify (genuine + wrong code) → reverse → desktop
  + mobile overflow → teacher redirect.
- Battery: auth, config, scope, ca (64), results, practice, engine, vault,
  authoring, timetable (23), jobs, backup, leak, platform, people (60),
  promotion (45), result-workflow (102), dashboards (21) — all green.

## Deliberate departures from legacy
- No JSON blobs: decisions are rows, queryable per student.
- No WP-Cron: issuance and verification are synchronous request-scoped
  work; nothing queued behind a cron.
- Print via the browser's own PDF pipeline (print.css), not rasterized
  output — documents remain text-selectable and exact.
- Verification code is HMAC-signed, not a random string stored in a lookup
  table — a DB dump alone cannot forge a verify code without the secret.
