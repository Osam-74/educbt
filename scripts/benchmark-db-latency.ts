/**
 * scripts/benchmark-db-latency.ts — candidate-DB latency benchmark.
 *
 * Run this FROM NIGERIA (owner's home/school network, no VPN) against each
 * candidate database connection string. It measures the real network path
 * between the person operating the platform and the database — which is the
 * path taken by admin operations, migrations, restore rehearsals and backup
 * verification, and a good general indicator of route quality to the
 * provider's region.
 *
 *   DATABASE_URL='postgres://...' npx tsx scripts/benchmark-db-latency.ts
 *   DATABASE_URL='postgres://...direct...' \
 *     POOLED_DATABASE_URL='postgres://...pooler...' \
 *     npx tsx scripts/benchmark-db-latency.ts --rounds 200 --conc 20
 *
 * What each phase measures:
 *   1. dns          — resolving the DB hostname (first lookup; OS-cached after)
 *   2. tcp          — TCP handshake to the DB port (network RTT floor)
 *   3. tls+auth     — full PostgreSQL connect minus TCP: TLS handshake,
 *                     authentication and session setup
 *   4. select       — a single simple SELECT over a long-lived connection
 *                     (pure per-query network round-trip)
 *   5. transaction  — BEGIN → SET LOCAL → SELECT → COMMIT. Note: under a
 *                     transaction-mode pooler (PgBouncer/Supavisor) SET LOCAL
 *                     must still succeed — it doubles as a pooling-safety
 *                     check for EduCBT's transaction-scoped RLS variables.
 *   6. churn        — full connect → one SELECT → disconnect, repeatedly
 *                     (what serverless/connection-churn patterns pay per op)
 *   7. pool burst   — N parallel workers × M queries through a client pool;
 *                     surfaces connection-limit errors and queueing
 *
 * Output: per-phase median / p95 / p99 / max in milliseconds, plus failures.
 *
 * Interpreting results (Nigeria → candidate region):
 *   select median  ≤  100 ms   good — comfortable for exam-time operation
 *   select median  ≤  150 ms   acceptable — fine for saves/loads of this app
 *   select median  >  200 ms   poor — pick a different region/provider
 *   Compare 'direct' vs 'pooled' — pooled should be similar or better;
 *   a pooled select p99 much higher than direct suggests pooler contention.
 *   'transaction' failing on a pooled target = transaction-mode incompatibility.
 *   In the real deployment, candidate browsers talk to Vercel (edge network),
 *   and Vercel functions talk to the DB — this benchmark measures YOUR path
 *   to the DB, not the candidates'. Region choice should keep both paths short.
 */

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { lookup } from 'node:dns/promises';
import pg from 'pg';

type Stats = { n: number; median: number; p95: number; p99: number; min: number; max: number; mean: number; failures: number };

function statsOf(samples: number[], failures = 0): Stats {
  if (samples.length === 0) return { n: 0, median: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, failures };
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    median: at(50),
    p95: at(95),
    p99: at(99),
    min: s[0] ?? 0,
    max: s[s.length - 1] ?? 0,
    mean: sum / s.length,
    failures,
  };
}

function fmtRow(phase: string, st: Stats, note = ''): string {
  const ms = (v: number) => v.toFixed(1).padStart(7);
  return (
    `  ${phase.padEnd(12)} median ${ms(st.median)} ms   p95 ${ms(st.p95)} ms   ` +
    `p99 ${ms(st.p99)} ms   max ${ms(st.max)} ms   n=${st.n}` +
    (st.failures ? `   FAILURES=${st.failures}` : '') +
    (note ? `   (${note})` : '')
  );
}

function sslFor(url: string) {
  // Managed providers ship sslmode=require in their URLs; node-postgres needs
  // the ssl option set explicitly. Providers use publicly-trusted certs, so
  // full verification is enabled.
  return /sslmode=require|sslmode=verify|ssl=true/.test(url) ? { rejectUnauthorized: true } : undefined;
}

async function benchTarget(label: string, url: string, rounds: number, conc: number) {
  console.log(`\n=== Target: ${label} ===`);
  const ssl = sslFor(url);
  const { hostname, port } = new URL(url.replace(/^postgres/, 'http'));
  const results: Record<string, Stats> = {};
  const notes: Record<string, string> = {};

  // 1. DNS
  const dnsTimes: number[] = [];
  try {
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      await lookup(hostname, { all: true });
      dnsTimes.push(performance.now() - t0);
    }
  } catch (err) {
    results.dns = statsOf([], 5);
    notes.dns = `lookup failed: ${(err as Error).message}`;
  }
  results.dns = results.dns ?? statsOf(dnsTimes);

  // 2. TCP connect
  const tcpTimes: number[] = [];
  let tcpFails = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: hostname, port: Number(port) || 5432 });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.setTimeout(10_000, () => { sock.destroy(); resolve(false); });
    });
    if (ok) tcpTimes.push(performance.now() - t0);
    else tcpFails++;
  }
  results.tcp = statsOf(tcpTimes, tcpFails);

  // 3. Full connect (TLS + auth) on a fresh client, repeated
  const connectTimes: number[] = [];
  let connFails = 0;
  for (let i = 0; i < 5; i++) {
    const client = new pg.Client({ connectionString: url, ssl });
    const t0 = performance.now();
    try {
      await client.connect();
      connectTimes.push(performance.now() - t0);
    } catch {
      connFails++;
    } finally {
      await client.end().catch(() => {});
    }
  }
  results['tls+auth'] = statsOf(connectTimes, connFails);
  if (connFails > 0) notes['tls+auth'] = 'connection failed — check credentials/SSL';
  if (connectTimes.length && results.tcp.n) {
    notes['tls+auth'] =
      (notes['tls+auth'] ? notes['tls+auth'] + '; ' : '') +
      `≈ ${Math.max(0, results['tls+auth'].median - results.tcp.median).toFixed(1)} ms beyond TCP`;
  }

  // Persistent client for 4–5
  const main = new pg.Client({ connectionString: url, ssl });
  await main.connect();
  await main.query('SELECT 1'); // warm

  // 4. Simple SELECT round-trips
  const selTimes: number[] = [];
  let selFails = 0;
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    try {
      await main.query('SELECT 1');
      selTimes.push(performance.now() - t0);
    } catch {
      selFails++;
    }
  }
  results.select = statsOf(selTimes, selFails);

  // 5. Small transaction with SET LOCAL (pooling-safety probe)
  const txTimes: number[] = [];
  let txFails = 0;
  let txIncompatible = false;
  for (let i = 0; i < Math.min(rounds, 200); i++) {
    const t0 = performance.now();
    try {
      await main.query('BEGIN');
      await main.query("SET LOCAL app.bench_probe = 'on'");
      await main.query('SELECT 1');
      await main.query('COMMIT');
      txTimes.push(performance.now() - t0);
    } catch (err) {
      txFails++;
      const msg = (err as Error).message;
      if (/SET LOCAL|transaction|pooler/i.test(msg)) txIncompatible = true;
      await main.query('ROLLBACK').catch(() => {});
    }
  }
  results.transaction = statsOf(txTimes, txFails);
  if (txIncompatible) notes.transaction = 'SET LOCAL failed — TRANSACTION-MODE INCOMPATIBLE';
  else if (txFails === 0 && /pooler|pgbouncer|supavisor|-pooler/i.test(url)) notes.transaction = 'SET LOCAL works under transaction pooling ✔';

  // 6. Connect churn (serverless-style)
  const churnTimes: number[] = [];
  let churnFails = 0;
  for (let i = 0; i < Math.min(rounds, 30); i++) {
    const client = new pg.Client({ connectionString: url, ssl });
    const t0 = performance.now();
    try {
      await client.connect();
      await client.query('SELECT 1');
      churnTimes.push(performance.now() - t0);
    } catch {
      churnFails++;
    } finally {
      await client.end().catch(() => {});
    }
  }
  results.churn = statsOf(churnTimes, churnFails);

  await main.end();

  // 7. Pool burst — conc workers × 10 queries
  const poolTimes: number[] = [];
  let poolFails = 0;
  const pool = new pg.Pool({ connectionString: url, ssl, max: conc });
  await pool.query('SELECT 1');
  await Promise.all(
    Array.from({ length: conc }, () =>
      (async () => {
        for (let i = 0; i < 10; i++) {
          const t0 = performance.now();
          try {
            await pool.query('SELECT 1');
            poolTimes.push(performance.now() - t0);
          } catch {
            poolFails++;
          }
        }
      })(),
    ),
  );
  await pool.end();
  results['pool burst'] = statsOf(poolTimes, poolFails);
  notes['pool burst'] = `${conc} parallel workers × 10 queries`;

  // Report
  const order: (keyof typeof results)[] = ['dns', 'tcp', 'tls+auth', 'select', 'transaction', 'churn', 'pool burst'];
  for (const k of order) console.log(fmtRow(k, results[k] as Stats, notes[k]));
  console.log(
    `\n  VERDICT: ${
      results.select.median <= 100
        ? 'GOOD — ≤100 ms median round-trip'
        : results.select.median <= 150
          ? 'ACCEPTABLE — ≤150 ms median round-trip'
          : 'POOR — >150 ms median round-trip; prefer another region/provider'
    }`,
  );
  return { target: label, url: url.replace(/:[^:@/]*@/, ':***@'), ...results, notes };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string, dflt: number) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
  };
  const rounds = flag('rounds', 200);
  const conc = flag('conc', 20);

  const targets: Array<[string, string]> = [];
  if (process.env.DATABASE_URL) targets.push(['direct', process.env.DATABASE_URL]);
  if (process.env.POOLED_DATABASE_URL) targets.push(['pooled', process.env.POOLED_DATABASE_URL]);
  if (targets.length === 0) {
    console.error('Set DATABASE_URL (and optionally POOLED_DATABASE_URL) — see file header for usage.');
    process.exit(1);
  }

  const all = [];
  for (const [label, url] of targets) all.push(await benchTarget(label, url, rounds, conc));

  console.log('\n=== JSON summary ===');
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), rounds, conc, targets: all }, null, 2));
}

main().catch((err) => {
  console.error('BENCHMARK FAILURE:', err instanceof Error ? err.message : err);
  process.exit(1);
});
