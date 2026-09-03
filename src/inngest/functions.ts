/**
 * The two scheduled jobs. This layer is deliberately thin glue: all real work
 * lives in plain services (src/lib/jobs/*) that know nothing about Inngest
 * and are covered by npm run test:jobs.
 *
 * Cadence decisions (README has the full rationale):
 *
 *   sweep-expired-attempts  — every minute. Server-authoritative deadlines
 *     only bite if the sweep is at least as granular as a countdown; a
 *     candidate whose time ran out must not keep typing for minutes more.
 *     One run sweeps EVERY active school, so cadence is per-deployment, not
 *     per-school. Inngest cron supports 1-minute schedules.
 *
 *   purge-expired-sessions   — hourly. Sessions live 12h and the sign-in
 *     opportunistic purge keeps the table small between runs; hourly is far
 *     below the lifecycle, at negligible volume (~744 runs/month).
 *
 * Concurrency: both jobs set concurrency 1 — Inngest queues an overlapping
 * run instead of executing it alongside. The services are idempotent anyway
 * (double sweep = no-op, double purge = 0 deleted), so a delayed or retried
 * run is safe even if it ever executes concurrently.
 *
 * Failure behaviour: a thrown error fails the run visibly in the Inngest
 * dashboard and the provider retries it. We log a structured error summary
 * first (job, counts so far, error message — never payloads) and rethrow —
 * swallowing would hide the failure from the provider.
 */

import { inngest } from './client';
import { purgeExpiredSessions } from '@/lib/jobs/session-cleanup';
import { sweepAllExpiredAttempts } from '@/lib/jobs/exam-sweep';

function log(fields: Record<string, unknown>) {
  // Structured single-line JSON — greppable now, shippable to Sentry later.
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

export const sweepExpiredAttemptsJob = inngest.createFunction(
  {
    id: 'sweep-expired-attempts',
    name: 'Sweep expired exam attempts (all active schools)',
    concurrency: 1,
    triggers: [{ cron: '* * * * *' }],
  },
  async () => {
    log({ job: 'sweep-expired-attempts', status: 'start' });
    try {
      const summary = await sweepAllExpiredAttempts();
      log({ job: 'sweep-expired-attempts', status: 'end', ...summary });
      return summary;
    } catch (err) {
      log({
        job: 'sweep-expired-attempts',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
);

export const purgeExpiredSessionsJob = inngest.createFunction(
  {
    id: 'purge-expired-sessions',
    name: 'Purge expired authentication sessions',
    concurrency: 1,
    triggers: [{ cron: '0 * * * *' }],
  },
  async () => {
    log({ job: 'purge-expired-sessions', status: 'start' });
    try {
      const deleted = await purgeExpiredSessions();
      log({ job: 'purge-expired-sessions', status: 'end', deleted });
      return { deleted };
    } catch (err) {
      log({
        job: 'purge-expired-sessions',
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
);

export const jobs = [sweepExpiredAttemptsJob, purgeExpiredSessionsJob];
