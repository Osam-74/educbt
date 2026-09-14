/**
 * Scheduled email queue drain, across every active school.
 *
 * The queue layer (src/lib/comms/email.ts) is provider-free by design: it
 * hands rows to a transport callback. This service is the production half —
 * it enumerates the schools and drains each one through the configured
 * transport. Resend is wired here; any other provider slots in behind the
 * same callback without touching the queue.
 *
 * Security posture — deliberately NO RLS bypass, mirroring exam-sweep:
 *   - School enumeration runs as the least-privileged educbt_app role and is
 *     permitted by the same deliberately narrow hostname_lookup policy on
 *     schools (active schools only). A suspended school stops being drained
 *     the moment it stops resolving — and its queued rows survive to be
 *     drained if it is reactivated.
 *   - Each school's drain runs through forSchool(schoolId) — the normal
 *     tenant-isolated path. No superuser, no owner credential, no BYPASSRLS.
 *
 * Failure behaviour: a school's failure is recorded and the NEXT school still
 * drains. Per-school drains are independent and idempotent — drainEmails
 * claims a row by bumping attempts before sending, so a crashed run never
 * resends indefinitely, and a retried or overlapping run is safe.
 *
 * No transport configured (RESEND_API_KEY / MAIL_FROM unset): the run is a
 * no-op, reported as skipped. Rows stay queued — the queue is the record of
 * what SHOULD have been sent, and the principal can still drain from the
 * portal with a manual transport.
 */

import { eq } from 'drizzle-orm';
import { db, schema, forSchool } from '@/db';
import { drainEmails, type QueuedEmail } from '@/lib/comms/email';

export interface DrainSummary {
  /** Active schools that were enumerated. */
  schoolsConsidered: number;
  /** Schools whose drain completed without error. */
  schoolsDrained: number;
  /** Rows handed to the transport and marked sent. */
  sent: number;
  /** Per-school failures. A school here did NOT stop the others. */
  failures: Array<{ schoolId: number; error: string }>;
  /** Set when no transport is configured — the run was a deliberate no-op. */
  skipped?: 'no_transport';
}

/**
 * The Resend transport. Plain fetch, no SDK: one dependency fewer, and the
 * API is a single POST. Errors surface as exceptions so the queue layer can
 * mark the row failed with the message — the same contract as every other
 * transport, including the test recorder.
 */
export function resendTransport(apiKey: string, from: string) {
  return async (email: QueuedEmail): Promise<void> => {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: email.toEmail,
        subject: email.subject,
        text: email.body,
      }),
    });

    if (!res.ok) {
      // Status is the whole message: it says what went wrong without ever
      // carrying a payload, an address or the body back into a log.
      throw new Error(`resend ${res.status}`);
    }
  };
}

/**
 * Drain every active school's queue through `transport`. Split from
 * drainAllQueuedEmails so tests exercise the enumeration/tenancy path with a
 * local recorder instead of a real provider.
 */
export async function drainAllSchoolsWith(
  transport: (email: QueuedEmail) => Promise<void>,
): Promise<DrainSummary> {
  const schools = await db
    .select({ id: schema.schools.id })
    .from(schema.schools)
    .where(eq(schema.schools.status, 'active'));

  let sent = 0;
  const failures: DrainSummary['failures'] = [];

  for (const school of schools) {
    const schoolId = Number(school.id);
    try {
      sent += await forSchool(schoolId, (tx) => drainEmails(tx, 100, transport));
    } catch (err) {
      // School-scoped isolation: record, continue, let the next run retry.
      // Only the error MESSAGE is kept — no addresses, no bodies.
      failures.push({
        schoolId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    schoolsConsidered: schools.length,
    schoolsDrained: schools.length - failures.length,
    sent,
    failures,
  };
}

/**
 * The scheduled entry point. Reads the production transport from the
 * environment; without credentials this is a reported no-op, never an error
 * — a pilot school without email configured is a supported state.
 */
export async function drainAllQueuedEmails(): Promise<DrainSummary> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();

  if (!apiKey || !from) {
    return {
      schoolsConsidered: 0,
      schoolsDrained: 0,
      sent: 0,
      failures: [],
      skipped: 'no_transport',
    };
  }

  return drainAllSchoolsWith(resendTransport(apiKey, from));
}
