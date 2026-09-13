/**
 * Provider-independent email event queue (legacy EmailQueueService parity,
 * without WP-Cron).
 *
 * The old plugin queued rows and a WP-Cron loop drained them. Here rows are
 * queued inside the same transaction as the work that caused them, and an
 * Inngest function drains the queue when production credentials exist. The
 * queue interface is deliberately provider-free: drain() hands rows to a
 * transport callback, so tests use a local transport and production can use
 * Resend behind the same call.
 *
 * Nothing here requires real credentials to run. A school with no transport
 * configured keeps its queued rows — they are the record of what SHOULD have
 * been sent, exactly like the legacy error column kept failures.
 */

import { asc, eq, and, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { getPrefs, type NotificationType } from './notifications';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A generated placeholder address is not a real inbox; students are created
 *  with one and mailing it would bounce for every student in the school. */
function isMailable(email: string): boolean {
  return EMAIL_RE.test(email) && !email.trim().endsWith('.invalid');
}

/** Resolve the best email address for a user. Parents sign in with email
 *  (loginId); staff carry an email column; students have none by design. */
async function emailForUser(tx: Tx, schoolId: number, userId: number): Promise<string | null> {
  const [user] = await tx
    .select({ role: schema.users.role, loginId: schema.users.loginId })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.schoolId, schoolId)));

  if (!user) return null;

  if (user.role === 'parent') {
    return isMailable(user.loginId) ? user.loginId : null;
  }

  if (user.role === 'principal' || user.role === 'vice_principal' || user.role === 'exam_officer' || user.role === 'teacher') {
    const [staffRow] = await tx
      .select({ email: schema.staff.email })
      .from(schema.staff)
      .where(and(eq(schema.staff.schoolId, schoolId), eq(schema.staff.userId, userId)));
    return staffRow?.email && isMailable(staffRow.email) ? staffRow.email : null;
  }

  // Students: no inbox. Platform admin: not a school user.
  return null;
}

export type QueuedEmail = {
  id: number;
  toEmail: string;
  subject: string;
  body: string;
};

/**
 * Queue an email if the user wants one. QUEUED, never sent inline — sending
 * to 500 guardians inside the request that published results would time out
 * and lose messages half way through, with no record of which half.
 */
export async function queueEmailForUser(
  tx: Tx,
  schoolId: number,
  userId: number,
  type: NotificationType,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  const prefs = await getPrefs(tx, schoolId, userId);
  if (!prefs.emailEnabled || prefs.mutedTypes.includes(type)) return;

  const to = await emailForUser(tx, schoolId, userId);
  if (!to) return;

  await queueEmail(tx, {
    schoolId,
    to,
    subject: title,
    body: link ? `${body}\n\n${link}` : body,
  });
}

export async function queueEmail(
  tx: Tx,
  input: { schoolId: number; to: string; subject: string; body: string },
): Promise<number> {
  if (!isMailable(input.to)) return 0;
  const [row] = await tx
    .insert(schema.emailEvents)
    .values({
      schoolId: input.schoolId,
      toEmail: input.to.trim(),
      subject: input.subject.trim().slice(0, 200),
      body: input.body,
    })
    .returning({ id: schema.emailEvents.id });
  return row ? row.id : 0;
}

export async function markSent(tx: Tx, id: number): Promise<void> {
  await tx
    .update(schema.emailEvents)
    .set({ status: 'sent', sentAt: new Date(), lastError: null })
    .where(eq(schema.emailEvents.id, id));
}

export async function markFailed(tx: Tx, id: number, error: string): Promise<void> {
  await tx
    .update(schema.emailEvents)
    .set({ status: 'failed', lastError: error.slice(0, 500) })
    .where(eq(schema.emailEvents.id, id));
}

/**
 * Drain up to `limit` queued events through a transport. The transport is a
 * callback so the queue stays provider-independent: tests pass a local
 * recorder, production wires Resend behind it. Rows are claimed by bumping
 * attempts BEFORE the send, so a crashed drain does not resend indefinitely;
 * a transport failure records last_error and marks the row failed for the
 * office to read — the same contract as the legacy queue.
 */
export async function drainEmails(
  tx: Tx,
  limit: number,
  transport: (email: QueuedEmail) => Promise<void>,
): Promise<number> {
  const rows = await tx
    .select({
      id: schema.emailEvents.id,
      toEmail: schema.emailEvents.toEmail,
      subject: schema.emailEvents.subject,
      body: schema.emailEvents.body,
      attempts: schema.emailEvents.attempts,
    })
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.status, 'queued'))
    .orderBy(asc(schema.emailEvents.createdAt))
    .limit(Math.min(limit, 100));

  let sent = 0;
  for (const row of rows) {
    await tx
      .update(schema.emailEvents)
      .set({ attempts: row.attempts + 1 })
      .where(eq(schema.emailEvents.id, row.id));
    try {
      await transport({ id: row.id, toEmail: row.toEmail, subject: row.subject, body: row.body });
      await markSent(tx, row.id);
      sent += 1;
    } catch (err) {
      await markFailed(tx, row.id, err instanceof Error ? err.message : String(err));
    }
  }
  return sent;
}

/** Queue statistics for the office view: what is pending, what failed. */
export async function queueStats(tx: Tx, schoolId: number) {
  const [row] = await tx
    .select({
      queued: sql<number>`count(*) FILTER (WHERE ${schema.emailEvents.status} = 'queued')::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${schema.emailEvents.status} = 'sent')::int`,
      failed: sql<number>`count(*) FILTER (WHERE ${schema.emailEvents.status} = 'failed')::int`,
    })
    .from(schema.emailEvents)
    .where(eq(schema.emailEvents.schoolId, schoolId));
  return row ?? { queued: 0, sent: 0, failed: 0 };
}

/** Principal-facing wrapper: drain the school's queue with a local transport.
 *  In production this call belongs to the Inngest function, not a click. */
export async function drainSchoolEmails(actor: Actor, transport: (email: QueuedEmail) => Promise<void>): Promise<number> {
  if (actor.role !== 'principal') {
    throw new Error('Only the principal can drain the email queue from the portal.');
  }
  return forSchool(actor.schoolId, (tx) => drainEmails(tx, 100, transport));
}
