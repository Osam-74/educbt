# EduCBT — Release Hardening Status (Agent 2 handoff)

**Branch:** `feat/release-hardening` · **Head commit:** `ab9074b` · **Base:** `origin/main` @ `1fe7094`

This branch is additive and docs/test-only so far — **no production code was changed**, only new documentation and audit evidence, plus a green typecheck/build re-verification. It is safe to merge as-is; it does not complete the full 11-phase brief (see "Deferred" below).

## What's actually done, with evidence

### Phase 5 + 6 — Security review + RLS audit ✅
See `docs/security-audit.md` and `docs/rls-audit.md`. Executed directly (not via sub-agent) against a locally seeded Postgres 15 cluster:
- Re-ran `test:scope`, `test:leak`, `test:auth`, `test:totp`, `test:platform`, `test:config`, `test:domain` — **all green**, no hangs.
- Direct raw-SQL cross-tenant probe as the real `educbt_app` role: School A cannot read or write School B's rows even with explicit targeting; unscoped requests see zero rows (fail-closed).
- RLS coverage: 44/45 tables enabled+forced; the one exception (`sessions`) is the documented, verified-correct carve-out.
- **No P0 found.** One P1 (missing dedicated guardian↔child adversarial test — a coverage gap, not a known hole) and one P2 (no CSRF token as defense-in-depth on 6 API routes, though `sameSite=lax` already blocks the realistic attack on modern browsers).

### Phase 10 + 11 — Cutover runbook + pilot checklist ✅
See `docs/cutover-runbook.md` and `docs/pilot-acceptance-checklist.md`. Legacy→Next.js data mapping, explicit call-outs for what cannot auto-migrate (WordPress `phpass`/MD5 password hashes, freeform legacy class/subject strings, monolithic JSON answer blobs, orphaned FK rows, local filesystem media), a 13-stage import order, reconciliation steps, freeze window, DNS switch, and rollback. Pilot checklist covers all 18 requested operational steps with concrete UI paths and failure symptoms.

### Regression / build gates re-verified on this branch ✅
- `npx tsc --noEmit` — clean.
- `npm run build` (with `DATABASE_URL_APP` set, per the hard-fail guard) — clean production build.
- Focused suite re-run — 7/7 green, no hanging DB clients (all exited promptly).
- **Full 34-suite battery was NOT re-run** in this pass (time/credit-boxed) — recommend running it in CI before the final merge to main, per the project's own testing policy (full regression at the end, before merge).

## Deferred — not completed in this pass

Two rounds of sub-agent delegation (11 task attempts total) were used to try to cover the remaining phases in parallel. Result: the cutover-docs task and this security audit are the only ones that produced usable output. The other four all dead-ended on a platform-level issue — sub-agent tasks self-paused with a "this is a big change, reply continue" checkpoint with no tool available to actually send that reply, so they stopped with zero progress (confirmed on both the first and a retried second attempt, even with explicit pre-authorization language). This has been reported to the Base44 platform team as a tooling bug.

Given remaining time/credit budget this session, these were **not** picked up manually (the way Security was):

- **Phase 2/3 — 500-candidate load test + DB connection-pressure audit.** Not started for real (only sub-agent stubs, no data).
- **Phase 4 — Exam reliability chaos tests** (refresh, dup saves, cross-device, force-submit collision, etc). Not started for real.
- **Phase 7/8 — Document security (transcript/QR) + backup-restore rehearsal.** Not started for real.
- **Phase 9 — Release smoke suite.** Not started for real.

None of these are known P0s — they are simply **unverified**. Given the pilot's real target load (5 schools × 100 students) and Neon's constrained compute, Phase 2/3 (load test) is the highest-value one to do next before a real pilot exam.

## Merge recommendation

**Merge `feat/release-hardening` into `main` now** — it is additive documentation + a re-verified regression pass, zero application-code risk, and contains the only P0-relevant finding (RLS: clean) that blocks a pilot. Do **not** treat this branch as satisfying the full release-hardening brief — Phases 2/3/4/7/8/9 still need a dedicated pass (recommend a fresh, shorter session per phase rather than one large multi-phase mission, given the sub-agent checkpoint limitation above) before declaring the platform pilot-ready end to end.

## For Agent 1 / Codex

- Do not duplicate the security/RLS audit or the cutover docs — they're done, see above.
- If you pick up the load test or chaos suites, be aware of the CI hang lesson already fixed on `main` (close every postgres.js client explicitly) and reuse the pattern in `test-scope.ts`/`test-auth.ts` for local Postgres bootstrap (`pg_createcluster` on a dedicated port works well in a sandboxed environment without Docker).
