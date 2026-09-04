# Production PostgreSQL Provider & Region Decision — EduCBT

**Date:** 2026-09-04 · **Status:** RECOMMENDED, pending owner confirmation and Nigeria benchmark validation · **No production database provisioned yet.**

EduCBT serves Nigerian schools with latency-sensitive examinations (initial bursts ≈ 500 concurrent candidates). The frontend runs on Vercel. This audit selects the production PostgreSQL provider and region before any account is created. All facts were verified against provider documentation in September 2026; pricing is approximate and usage-dependent.

## Recommendation

| Item | Decision |
|---|---|
| Provider | **Neon** (`neon.tech`, "Lakebase Postgres" by Databricks) |
| Region | **`aws-eu-west-2` — London** |
| Vercel function region | **`lhr1` — London** (same city as the DB) |
| Starter compute | Autoscaling **min 0.5 CU, max 4 CU** (1 CU ≈ 1 vCPU + 4 GB RAM) |
| Scale-to-zero | **DISABLED** on the Launch plan — compute stays warm 24/7, no exam cold start |
| Connection mode | App runtime → **pooled endpoint (PgBouncer transaction mode)**; migrations → **direct endpoint**; backups → **direct endpoint with owner credential** |
| Backup posture | **Dual:** provider PITR (up to 7-day history window on Launch) + our portable nightly `pg_dump` → Firebase Storage (already verified end-to-end) |
| PostgreSQL major | **18** — matches the dev/test stack (embedded PG 18) exactly; Neon supports 14–18 |
| Approx. pilot cost | **$20–35/mo** (0.5 CU always-on ≈ 365 CU-h × $0.106, + storage $0.35/GB-mo, + small PITR history) |

## Why London

Public latency data puts Lagos ↔ London at ~100 ms RTT (wonder network / cable routes via MainOne, Glo-1, WACS land in Portugal/UK) — the best-connected European endpoint from Nigeria. Lagos ↔ Frankfurt/Ireland measures slightly worse; Lagos ↔ Cape Town often routes via Europe and is no better (~130–160 ms), despite being on the same continent. Vercel's function region `lhr1` is co-located with Neon's `aws-eu-west-2`, so the function→DB hop is ~1–3 ms. The owner should validate from Nigeria with `npm run benchmark:db` before finalising.

Provider regions relevant to Nigeria (2026):

| Provider | Candidate regions near Nigeria | Notes |
|---|---|---|
| Neon | London (`aws-eu-west-2`), Frankfurt (`aws-eu-central-1`) | Region list shrank in 2026 to 8 AWS regions; **Ireland is gone**, Azure regions deprecated. No Africa region. |
| Supabase | London, Paris, Frankfurt, Ireland (17 AWS regions) | No Africa region. |
| Vercel functions | `lhr1` London, `cdg1` Paris, `fra1` Frankfurt, `dub1` Dublin, `cpt1` Cape Town | Functions pin to one region; pair it with the DB region. |
| AWS RDS | `af-south-1` Cape Town (pairs with `cpt1`) | Only true Africa option; heavier ops, worse measured latency from Lagos. |

## Provider comparison (summary)

| | **Neon** | **Supabase** | Railway | Render | AWS RDS |
|---|---|---|---|---|---|
| Pure Postgres fit | ★★★ pure Postgres + branches | ★★☆ platform bundle (auth/storage/realtime unused) | ★★★ plain instance | ★★★ plain instance | ★★★ full control |
| Cold start risk | Controllable — **disable scale-to-zero on Launch** | None — compute is fixed, always on | None | None (always on) | None |
| Pooling | Built-in PgBouncer, **up to 10,000 client connections**, transaction mode | Supavisor, transaction mode; hard-coded limits by tier (~200 pooled on entry tiers) | Not built-in (self-run PgBouncer) | Built-in PgBouncer (no extra cost) | None — needs RDS Proxy (~$15–25/mo extra) |
| Connection model support | Pooled + direct endpoints ✔ | Direct (5432) + pooled (6543) ✔ | Single endpoint | Pooled + direct ✔ | Endpoint + proxy |
| PG version | **14–18 (18.6)** — parity with our stack | 15 → 17 (hosted; 18 not offered) | 13–17 | 14–17 | 12–18 |
| Provider backups/PITR | Built into storage layer; Launch window up to **7 days**, $0.20/GB-mo history + snapshots | Daily backups on Pro (7-day retention); **PITR ≈ $100/mo** | Daily backups; PITR limited/unclear | Daily backups + PITR on paid | Automated backups + PITR 0–35 days (included) |
| Exam-burst behaviour | Autoscaling (resize lag exists; exam ramps are gradual) | Fixed compute, zero autoscale dynamics | Fixed, must size manually | Fixed, must size manually | Fixed, must size manually |
| Reliability posture | Databricks-owned; Azure regions deprecated 2026 (strategic flux); storage multi-AZ | Independent, Postgres-first, stable direction | Smaller platform, thinner DB story | Solid, smaller | Gold standard |
| Vercel region pairing | `lhr1` with London | `lhr1` with London | No London | Frankfurt only (`fra1`) | `cpt1` with Cape Town |
| Pilot cost | ~$20–35/mo | ~$25–35/mo | ~$5–20/mo (Hobby) | ~$7–34/mo | ~$30–50/mo + ops time |
| Maintenance burden | Minimal | Minimal | Medium (self-run pooling, thin backups) | Low-medium | **High** (VPC, SGs, patching, proxy, allowlists) |
| Portability | Plain `pg_dump`, branches ease migrations | Plain `pg_dump` (plus ignorable platform schemas) | Plain | Plain | Plain |
| RLS / custom roles / non-superuser app role / FORCE RLS / TLS | ✔ full support | ✔ (hosted `postgres` role is not true superuser — sufficient) | ✔ | ✔ | ✔ |
| Verdict | **Recommended** | **Runner-up** | Not exam-critical grade | Not exam-critical grade | Only if data-residency in Africa is ever mandated |

## Why Neon won; why Supabase lost (narrowly)

- The codebase was designed for Neon's pooled/unpooled endpoint model (`DATABASE_URL` / `DATABASE_URL_UNPOOLED`), so the connection architecture lands with zero rework.
- PG 18 parity with the dev/test stack — Supabase hosted tops out at PG 17.
- Pooled-connection headroom (10k vs ~200) comfortably absorbs Vercel serverless connection churn at exam peaks.
- PITR is included cheaply; Supabase's is ~$100/mo.
- Supabase's advantages — fixed always-on compute (zero cold-start risk even in theory) and an independent, stable corporate direction — keep it the designated fallback. Neon's Databricks ownership (Lakebase pivot, Azure-region deprecation, region-list shrink) is a real strategic risk, mitigated by: our portable nightly `pg_dump` backups, the restore-rehearsal tooling, and plain-Postgres portability that makes a Supabase-London move a migration, not a rebuild.

## Exam-workload sizing (500 concurrent candidates)

500 browser sessions ≠ 500 PostgreSQL connections. Candidates talk to Vercel functions; each function instance holds a constrained pool (max 1 connection per instance, by design), and those go through Neon's PgBouncer (transaction mode). Expected concurrent DB clients: ~20–60; expected peak query rate: ~50–200/s (question loads, idempotent answer saves, submits). The app's `SET LOCAL` transaction pattern is pooling-safe by construction — verified by the benchmark script's transaction probe and the existing test battery. 0.5 CU min (2 GB RAM) with autoscale to 4 CU handles this comfortably; min 0.25 CU would likely also cope but leaves less headroom for submit storms.

## Nigeria benchmark (owner-run, before finalising)

The sandbox is not in Nigeria, so no numbers here are presented as Nigeria latency. Run from a Nigeria connection (school/home network, no VPN):

```bash
# For each candidate: create a small trial project, then:
DATABASE_URL='<direct connection string>' \
POOLED_DATABASE_URL='<pooled connection string>' \
npm run benchmark:db -- --rounds 200 --conc 20
```

Suggested targets: Neon trial in London AND Frankfurt (and optionally Supabase trial in London). Interpretation: `select` median ≤100 ms good, ≤150 ms acceptable, >200 ms pick another region; `transaction` must pass on the pooled target (SET LOCAL compatibility). Pick the region with the best medians; London is expected to win.

## Recovery posture (unchanged)

Nightly `pg_dump` → Firebase Storage (verified) + Neon PITR/branch-restore + restore-rehearsal tooling. Disaster-recovery order remains as documented in the README runbook; Neon adds a provider-level instant-restore option for the "dropped table, minutes ago" class of incident.

---

*Sources consulted Sept 2026: neon.com/docs (regions, pricing, version policy, PITR FAQ, compatibility), supabase.com/docs + pricing pages, render.com docs/changelog, railway blog + pricing pages, aws.amazon.com pricing, vercel.com/docs/regions, wonder-network public latency statistics.*
