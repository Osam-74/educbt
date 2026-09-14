# Performance & Reliability Verification — Report

**Date:** 2026-09-14 · **Branch:** `feat/performance-reliability` · **Scope:** exam-day load, failure-mode reliability, post-deploy smoke

## Verdict

**Merge: APPROVED.** Every invariant the platform promises held under load and
under failure. No application-code defects were found (P0/P1 in the harness
only, see below). The exam lifecycle — start, save, resume, expiry, submit —
is idempotent, server-authoritative, and tenant-safe at every point it was
attacked.

## Method

Four phases, all against the real HTTP surface (no mocked paths), the real
production build (`next start`), and the real database:

1. **Load (k6)** — 100 / 250 / 500 candidates sit a published 60-question
   paper concurrently: sign-in → exam start → 60 answer saves (plus repeats)
   → mid-exam refresh → submit. `load/run.sh` wraps a full run: seed, DB
   reset, a DB-pressure observer, the k6 journey, and post-run DB
   verification of every invariant.
2. **Code audit** — the exam-start / answer-save / submit paths, query by
   query, with per-query timing captured at the DB.
3. **Chaos suite** (`scripts/chaos-suite.ts`) — ten real-world failure modes
   (duplicate saves, offline→reconnect, refresh, close→reopen, two-device
   races, expiry while disconnected, submit/expiry races, force-submit
   races, repeated submit, save-vs-submit race) plus a cross-tenant probe.
4. **Smoke suite** (`scripts/smoke-suite.ts`) — a fast post-deploy gate over
   DB connection, auth, tenant resolution/isolation, exam journey, result
   retrieval, and public transcript verification.

## Results

| Suite | 100 cand. | 250 cand. | 500 cand. |
|---|---|---|---|
| k6 checks passed | 100% | 100% | 100% |
| HTTP failures | 0.00% | 0.00% | 0.00% |
| Journey completes | 100/100 | 250/250 | 500/500 (5m 14s) |
| DB invariants verified | all | all | all |

Chaos suite: **24/24 passed.** Smoke suite: **12/12 passed.**

### Database behavior under peak (500 candidates)

- **Connections:** never more than 2 active (the app pins `max:1` per
  instance by design — Vercel Fluid; capacity scales horizontally).
- **Slowest query observed:** 18 ms. No lock waits, no deadlocks.
- **DB pressure observer:** connections and latency never left the green —
  the database was never the bottleneck on a 1-vCPU sandbox.

### Latency (500 candidates, 1-vCPU sandbox — reference only)

`answer_save p50 ≈ 2.8s, exam_start p50 ≈ 7.7s, submit p50 ≈ 11s`. These
numbers reflect the sandbox serializing 500 users through one vCPU and one
app instance; they are NOT a production projection. Production capacity
comes from Fluid horizontal scaling (many instances, one pooled DB
connection each). The load harness is repeatable on any host for a real
projection: `./load/run.sh 500`.

## Invariants verified (all runs, at the DB level)

- One attempt per candidate per paper — refresh, reopen, second device all
  resume, never restart.
- Exactly one answer row per question — duplicate saves, retries, and
  two-device concurrent writes collapse to one row.
- Question order is frozen at attempt creation.
- Timers are server-authoritative: a save after expiry is refused (409
  `expired`), and expiry never resets or restarts an attempt.
- Submit is idempotent — racing submits (up to 3 concurrent) all return 200
  and converge on one deterministic `submitted` state with a stable score.
- No answer ever crossed a tenant boundary (verified per-attempt for all
  500 attempts, plus an explicit cross-tenant probe: 409 `not_yours`).
- Sessions are session-scoped, not hostname-scoped (by design,
  `src/lib/session.ts`) — a session on another tenant's host still reads
  only its own school's rows.

## Findings

**P0 (production blockers): none.**

**P1 (fixed on this branch — test harness only, no app code):**

1. k6 CLI `--vus/--iterations` overrides silently rebuild the scenario and
   drop `maxDuration`, capping a 500-user run at 10 minutes (k6 default). The
   scenario is now defined in the script (`load/k6/exam.js`) with
   `CANDIDATES` via env, `maxDuration: '45m'`.
2. Node `fetch` pins the `Host` header to the URL authority, which broke
   tenant routing and Next.js server-action origin checks for the TS suites.
   Both suites now drive tenant hostnames in the URL (local runs map
   `load*.localhost` → 127.0.0.1 in `/etc/hosts) and send
   `x-forwarded-host` explicitly on server-action POSTs.
3. Chaos suite ran at a point the smoke journey couldn't repeat against the
   same candidate (already-submitted state) — the smoke suite now reports
   that state as an explicit SKIP with remediation instead of a failure.

**P2 (notes, no action required):**

- `exam_refresh_latency` and `answer_repeat_latency` cost full page/API
  round-trips; both are well within tolerance under load and correct.
- The smoke suite needs a candidate without a closed attempt on the target
  paper for the full journey (SMOKE_LOGIN); everything else is rerunnable
  as-is.

## Reproduction

```bash
# load (local, seeded tenants load1..load5, 100 candidates each of papers)
set -a && . ./.env.local && set +a && ./load/run.sh 500

# chaos + smoke
set -a && . ./.env.local && set +a
npx tsx scripts/chaos-suite.ts
SMOKE_ALT_PAPER_ID=2 npx tsx scripts/smoke-suite.ts

# staging smoke (no DB access needed)
SMOKE_BASE_URL=https://<tenant-host> SMOKE_HOST=<tenant-host> \
  SMOKE_LOGIN=<smoke-candidate> SMOKE_PASSWORD='<password>' \
  SMOKE_ALT_HOST=<other-tenant-host> npx tsx scripts/smoke-suite.ts
```

Raw run artifacts: `load/results/<timestamp>-n<N>/` (k6 summary, console,
DB-pressure series, verification output) — not committed.
