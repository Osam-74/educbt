/**
 * Scheduled expired-attempt sweep, across every active school.
 *
 * The engine's sweepExpired(schoolId) is the tenant-scoped half: it finds
 * in_progress attempts past their authoritative server deadline and
 * auto-submits each one through the SAME submitAttempt path a candidate
 * would use (marking objective answers, preserving saved answers, no-op on
 * anything already submitted). This service is the platform half: enumerate
 * the schools, then let each sweep run inside its own tenant scope.
 *
 * Security posture — deliberately NO RLS bypass:
 *   - The enumeration runs as the least-privileged educbt_app role and is
 *     permitted by the existing, deliberately narrow hostname_lookup policy
 *     on schools: FOR SELECT, TO educbt_app, ACTIVE schools only. That is
 *     the same window the sign-in page uses; a suspended school therefore
 *     stops being swept the moment it stops resolving.
 *   - Each school's sweep then runs through forSchool(schoolId) — the
 *     normal tenant-isolated path. No superuser, no owner credential, no
 *     BYPASSRLS anywhere.
 *
 * Failure isolation: one school's failure is recorded and the NEXT school
 * still sweeps. There is no cross-tenant transaction — each school's sweep
 * is independent and idempotent, so a retried or overlapping run is always
 * safe (submitAttempt treats a non-in_progress attempt as a no-op).
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';
import { sweepExpired } from '@/lib/exam/engine';

export interface SweepSummary {
  /** Active schools that were enumerated. */
  schoolsConsidered: number;
  /** Schools whose sweep completed without error. */
  schoolsSwept: number;
  /** Attempts closed (auto-submitted) across all swept schools. */
  attemptsClosed: number;
  /** Per-school failures. A school here did NOT stop the others. */
  failures: Array<{ schoolId: number; error: string }>;
}

export async function sweepAllExpiredAttempts(): Promise<SweepSummary> {
  const schools = await db
    .select({ id: schema.schools.id })
    .from(schema.schools)
    .where(eq(schema.schools.status, 'active'));

  let attemptsClosed = 0;
  const failures: SweepSummary['failures'] = [];

  for (const school of schools) {
    const schoolId = Number(school.id);
    try {
      attemptsClosed += await sweepExpired(schoolId);
    } catch (err) {
      // School-scoped isolation: record, continue, let the next run retry.
      // Only the error MESSAGE is kept — no payloads, no answers.
      failures.push({
        schoolId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    schoolsConsidered: schools.length,
    schoolsSwept: schools.length - failures.length,
    attemptsClosed,
    failures,
  };
}
