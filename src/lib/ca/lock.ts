import { sql } from 'drizzle-orm';
import type { Tx } from '@/db';

/** Serialize score entry, compilation and lifecycle changes for one school/term.
 * Covers the absent-result case, where SELECT FOR UPDATE has no row to lock.
 * Transaction-scoped, so pooling and failures automatically release the lock.
 */
export async function lockResultTerm(tx: Tx, schoolId: number, sessionId: number, termId: number) {
  // Configuration writers take this school lock exclusively, before any term
  // lock. A score/configuration race must not bypass compatibility checks.
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`educbt-config:${schoolId}`}, 0))`);
  const key = ['educbt-results', schoolId, sessionId, termId].join(':');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
