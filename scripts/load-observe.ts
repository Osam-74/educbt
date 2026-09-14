/**
 * DB pressure observer — Phase 2 of the performance/reliability harness.
 *
 * Samples the local Postgres every interval while a load test runs and
 * appends one JSON line per sample to the output file. Watched signals:
 *   - connection counts by role and by state (active / idle in transaction)
 *   - oldest transaction age in seconds (transaction duration)
 *   - lock waits (blocking pairs) — lock contention
 *   - server uptime counters: xact_commit, xact_rollback, deadlocks,
 *     conflicts (recovery/serialization), buffers backend FS reads
 *
 * LOCAL ONLY — refuses non-loopback targets.
 *
 *   set -a && . ./.env.local && set +a
 *   npx tsx scripts/load-observe.ts --interval 2 --out load/observe-500.jsonl &
 *   kill %1  (samples are flushed per line, so SIGTERM is safe)
 */

import postgres from 'postgres';
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
function arg(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return fallback;
  return Number(args[i + 1]) || fallback;
}

const INTERVAL_SECONDS = arg('interval', 2);
const OUT = args[args.indexOf('--out') + 1] ?? 'load/observe.jsonl';

const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
if (!ownerUrl) {
  console.error('FAIL  DATABASE_URL_UNPOOLED is required.');
  process.exit(1);
}
try {
  const host = new URL(ownerUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error('FAIL  Refusing to observe a non-loopback database.');
    process.exit(1);
  }
} catch {
  console.error('FAIL  DATABASE_URL_UNPOOLED is not a parseable URL.');
  process.exit(1);
}

// Observer on its own small client, explicitly closed on SIGINT/SIGTERM.
const owner = postgres(ownerUrl, { max: 1, idle_timeout: 5 });
let stopped = false;

async function sample() {
  const t = Date.now();

  const roles = await owner<Array<{ usename: string | null; state: string; n: number }>>`
    SELECT usename, state, count(*)::int AS n
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY usename, state`;

  const oldestTx = await owner<Array<{ age: number | null }>>`
    SELECT COALESCE(EXTRACT(EPOCH FROM max(now() - xact_start))::int, 0) AS age
    FROM pg_stat_activity
    WHERE datname = current_database() AND xact_start IS NOT NULL`;

  const waits = await owner<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM pg_locks blocked
    WHERE NOT granted`;

  const stats = await owner<Array<{
    commits: number; rollbacks: number; deadlocks: number;
    conflicts: number; blks_read: number;
  }>>`
    SELECT xact_commit::bigint AS commits, xact_rollback::bigint AS rollbacks,
           COALESCE(deadlocks, 0)::bigint AS deadlocks,
           COALESCE(conflicts, 0)::bigint AS conflicts,
           COALESCE(blks_read, 0)::bigint AS blks_read
    FROM pg_stat_database WHERE datname = current_database()`;

  const s = stats[0]!;

  appendFileSync(OUT, JSON.stringify({
    t,
    interval: INTERVAL_SECONDS,
    roles: Object.fromEntries(
      roles.map((r) => [`${r.usename ?? 'unknown'}:${r.state}`, r.n]),
    ),
    oldestTxSeconds: oldestTx[0]?.age ?? 0,
    lockWaits: waits[0]?.n ?? 0,
    commits: String(s.commits), rollbacks: String(s.rollbacks),
    deadlocks: String(s.deadlocks), conflicts: String(s.conflicts),
    blksRead: String(s.blks_read),
  }) + '\n');
}

process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });

async function loop() {
  while (!stopped) {
    try {
      await sample();
    } catch (error) {
      appendFileSync(OUT, JSON.stringify({ t: Date.now(), error: String(error) }) + '\n');
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  }
  // The CI exit-hang lesson applies to tooling too: close the client.
  await owner.end();
  console.log(`INFO  observer stopped; samples in ${OUT}`);
}

loop();
