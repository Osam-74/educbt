/**
 * Scheduled session purge.
 *
 * The opportunistic purge at sign-in (session-store.ts) keeps the table tidy
 * between runs, but it only fires when somebody signs in — a quiet school on
 * a quiet weekend accumulates rows. THIS service is the real lifecycle
 * mechanism, invoked on a schedule (see src/inngest/functions.ts).
 *
 * Sessions are intentionally GLOBAL infrastructure records — not
 * school-scoped — because a session token must be resolved BEFORE the tenant
 * is known. rls.sql documents that exemption and db:verify's catalog-driven
 * check allows exactly this one table. The purge therefore needs no tenant
 * context, runs on the least-privileged application role, and only ever
 * deletes rows whose expiry is in the past.
 *
 * Properties:
 *   - Idempotent: running it twice deletes the same set once.
 *   - Uses the sessions_expiry_idx index (WHERE expires_at < now()).
 *   - Never touches active sessions.
 *   - Never logs or returns token material — the id column IS the SHA-256
 *     digest and even that stays out of the summary; only a count leaves.
 */

import { lt } from 'drizzle-orm';
import { db, schema } from '@/db';

export async function purgeExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, new Date()))
    .returning({ id: schema.sessions.id });

  return deleted.length;
}
