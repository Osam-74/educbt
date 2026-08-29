/**
 * Database access.
 *
 * There is exactly one rule in this file and the whole tenancy model rests on
 * it: **feature code never imports `sql` or `db` directly.** It calls
 * `forSchool(schoolId, fn)`, which opens a transaction, pins the tenant for its
 * duration, and runs the work inside.
 *
 * Two things make that safe:
 *
 *   SET LOCAL — the setting lives only for the transaction. Neon pools through
 *   PgBouncer in transaction mode, so a connection handed to School A's request
 *   and then to School B's would otherwise carry A's tenant into B. `LOCAL`
 *   ends at COMMIT, which is exactly the pooling boundary.
 *
 *   Fail closed — an unset tenant yields NULL, NULL never equals a school_id,
 *   and the query returns nothing. A forgotten scope produces an empty screen,
 *   never someone else's data.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql as dsql } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import * as questionBank from './schema/questions';
import * as vault from './schema/vault';
import * as attemptsSchema from './schema/attempts';

export const schema = { ...core, ...people, ...questionBank, ...vault, ...attemptsSchema };

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Use the POOLED Neon endpoint (-pooler host); the ' +
    'unpooled one is for migrations only and will exhaust connections under ' +
    'examination load.',
  );
}

/**
 * `prepare: false` is required by PgBouncer transaction mode — prepared
 * statements are per-session and the session is not yours between transactions.
 *
 * `max: 1` under Vercel Fluid compute: each warm instance keeps one connection
 * and serves concurrent requests through it, rather than every invocation
 * opening its own. At 0.25 CU, Postgres allows ~104 direct connections; a burst
 * of exam starts would exhaust that in seconds without pooling.
 */
const client = postgres(connectionString, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});

const db = drizzle(client, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Run work scoped to one school.
 *
 * Everything inside sees only that school's rows, enforced by Postgres rather
 * than by the caller remembering a WHERE clause.
 */
export async function forSchool<T>(
  schoolId: number,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    throw new Error(`forSchool called with an invalid school id: ${schoolId}`);
  }

  return db.transaction(async (tx) => {
    // Parameterised, not interpolated. The id is validated above, but a tenant
    // setter is the last place to hand-build SQL.
    await tx.execute(dsql`SELECT set_config('app.school_id', ${String(schoolId)}, true)`);
    return fn(tx);
  });
}

/**
 * Platform-operator access that crosses tenant boundaries.
 *
 * Deliberately awkward to call, and it writes to the audit log before doing any
 * work. A platform operator can administer infrastructure without casually
 * reading a school's student records, and if they do read them there is a
 * record of who, when and why.
 */
export async function asPlatformAdmin<T>(
  actorUserId: number,
  reason: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!reason || reason.trim().length < 10) {
    throw new Error(
      'Platform-admin access requires a written reason of at least 10 characters. ' +
      'It is recorded in the audit log.',
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(dsql`SELECT set_config('app.platform_admin', 'on', true)`);

    await tx.insert(people.auditLog).values({
      schoolId: null,
      actorUserId,
      actorRole: 'platform_admin',
      action: 'platform_admin.elevated_access',
      reason,
    });

    return fn(tx);
  });
}

/**
 * Unscoped, for the hostname → school lookup that necessarily happens before a
 * tenant exists. Nothing else may use it.
 */
export async function resolveSchoolByHost(host: string) {
  const rows = await db.execute<{ id: number; name: string; status: string }>(
    dsql`SELECT id, name, status FROM schools
         WHERE custom_domain = ${host} OR subdomain = ${host.split('.')[0] ?? ''}
         LIMIT 1`,
  );

  return rows[0] ?? null;
}

export { db, client };
