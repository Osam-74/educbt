# EduCBT — Application Security Audit (Phase 5)

**Scope:** repository/local review + local Postgres 15 test cluster (port 5435). No production access, no external network attacks. Branch: `feat/release-hardening-security`.

**Method:** code review of `src/middleware.ts`, `src/lib/auth/*`, `src/db/rls.sql`, plus real execution of the existing test battery against a locally seeded database (`npm run db:seed` fixtures already present) and hand-written raw-SQL cross-tenant probes.

## Summary table

| Area | Finding | Severity |
|---|---|---|
| Session cookie | `httpOnly`, `sameSite=lax`, `secure` in production. Token stored hashed, unguessable. | OK |
| CSRF | No explicit CSRF token. 56 Server Actions get Next.js's built-in same-origin check. 6 plain API routes (`/api/exam/**`, `/api/inngest`) rely on `sameSite=lax` blocking cross-site cookie-bearing POSTs. | **P2** — adequate on modern browsers, no defense-in-depth token |
| Session validity | Middleware only checks cookie *presence* (edge, no DB); real validity (expiry/suspension/lockout/forced-password-change) re-checked server-side on every request from the live row — verified by `test:auth` (14/14 pass, including suspension ending a live session and reactivation restoring it). | OK |
| TOTP | RFC 6238 engine; wrong code burns lockout budget, missing code does not; clock-drift previous-step code accepted; disable requires a valid current code. Verified by `test:totp` (13/13 pass). | OK |
| Role/capability escalation | `test:scope` (6/6 pass): a teacher cannot reach a class/student outside their assignment; school-wide roles see the whole school; an unassigned teacher reaches nothing. | OK |
| Answer/marking-guide leakage | `test:leak` (11/11 pass, including a deliberate self-check that proves the test *can* detect a leak): candidate payload never carries `isCorrect`, marking guide, or approval state. | OK |
| Platform onboarding / audit | `test:platform` (13/13 pass): temporary passwords never appear in audit records; **no owner DB credential found in any application runtime module** (explicit check, passed); suspension takes effect immediately for already-live sessions. | OK |
| Rate limiting / lockout | Per-account lockout with exponential backoff in `src/lib/auth/throttle.ts`, plus Upstash-backed request throttling referenced in the codebase. Verified functionally via `test:totp`'s lockout-budget assertions. | OK |
| Guardian relationship checks | Enforced via `guardian_student` join table + RLS `school_id` scoping (see rls-audit.md). **Closed** — see below, `test:guardian-scope` (7/7 PASS). | OK (was P1, now closed) |
| Direct-URL / IDOR | Every school-owned table carries a denormalized `school_id` and is RLS-scoped (see rls-audit.md); a guessed/incremented ID from another tenant resolves to zero rows at the database layer regardless of what the route code does — this is the strongest possible IDOR mitigation (fails closed even if an app-layer check is missing). | OK |
| Owner-credential hygiene | The **build hard-fails** if `DATABASE_URL_APP` is unset (documented, and re-confirmed present in `test:platform`'s "no owner DB credential in application runtime modules" check). | OK |

## Detail: CSRF posture

- Mutations mostly go through Next.js **Server Actions** (`'use server'`, 56 occurrences under `src/app/`), which since Next.js 13.4 verify the request `Origin` against the deployment host and reject cross-origin submissions automatically.
- The remaining mutation surface is 6 plain Route Handlers, all exam-critical: `answer`, `event`, `feedback`, `submit` under `/api/exam/[attemptId]/`, plus `/api/inngest`. These do not get the Server Action origin check. They are protected instead by the session cookie's `sameSite=lax`, which modern browsers exclude from cross-site POST requests — a cross-origin form/fetch POST from an attacker page will not carry the session cookie, so the request fails auth before reaching business logic.
- **Recommendation (P2, optional hardening):** add an explicit `Origin`/`Sec-Fetch-Site` header check on the 6 API routes as defense-in-depth for pre-`SameSite` browsers. Not a blocker for pilot.

## Detail: session lifecycle (evidence)

`npm run test:auth` (14/14 PASS) proves, against a real database:
- Session expiry (~12h) and metadata recorded correctly.
- A suspended school ends *already-open* sessions on the very next request (not just new sign-ins).
- Reactivation restores access immediately without requiring a fresh sign-in.
- A forced password-change flag is live in the session on the next read.
- Sign-out ends exactly one session; a password change ends every device's session (session-wide invalidation).
- Platform-admin sessions carry no tenant (`school_id IS NULL`), consistent with the RLS carve-outs in `rls.sql`.

## Findings requiring follow-up

1. ~~P1 — test-coverage gap: guardian↔child adversarial test~~ — **CLOSED.** Added `src/db/test-guardian-scope.ts` (`npm run test:guardian-scope`), a focused adversarial suite against real data across two real schools. 7/7 PASS:
   - A guardian cannot access another guardian's child (same school, no link).
   - Being a registered parent-role user in a school is not itself sufficient — the specific `guardian_student` link is the actual gate, not school membership.
   - A cross-school relationship is rejected at **both** the read path (`reportAudience` can never resolve a foreign school's student, RLS-backed) and the write path (`linkGuardian` refuses to create a link to a student outside the actor's own school — throws `StudentError('That student could not be found.')` rather than silently succeeding).
   - A revoked link (`guardian_student.can_view_results = false`) denies access even though the relationship row still exists; re-enabling the flag restores access, proving the gate is the flag itself and not a fixture artifact.
   - Positive control included (a guardian's own active, linked child correctly resolves `'family'`) so the suite can't pass by everything trivially returning null.
2. **P2 — CSRF defense-in-depth:** see above; optional, not a pilot blocker given current browser support for `SameSite`.

No P0 application-security issues were found in this pass. See `docs/rls-audit.md` for the tenant-isolation (RLS) audit, which is the primary tenant-security boundary and was tested directly with raw cross-tenant SQL probes.
