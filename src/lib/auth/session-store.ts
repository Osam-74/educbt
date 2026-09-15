/**
 * Database session store.
 *
 * Auth.js cannot honour this codebase's session contract: its Credentials
 * flow only ever issues a signed JWT (in beta.25 the token is encoded even
 * when the configured strategy is "database"), which means a suspended
 * student would keep access until token expiry — precisely what the schema
 * forbids. So the session layer is ours: rows in the sessions table, an
 * unguessable token in an httpOnly cookie, and the LIVE user row re-read on
 * every request. No library silently decides the strategy; there is no
 * strategy to get wrong.
 *
 * Security properties, and where each is enforced:
 *   - Token is 256 bits, base64url, and the sessions table stores ONLY its
 *     SHA-256. A database leak therefore does not yield usable cookies.
 *   - The cookie is httpOnly + sameSite=lax, secure in production, and lives
 *     for a school day (12h) — not a fortnight.
 *   - Every read checks expiry AND the live user row (status, lockout,
 *     forced password change), so suspending an account takes effect on the
 *     student's NEXT request, not at token expiry.
 *   - The pre-tenant user read is bounded by the session_user_lookup RLS
 *     policy to exactly the user the presented token references. Fail closed.
 *
 * This module is deliberately free of next/* imports so the full lifecycle is
 * regression-testable from plain scripts (src/db/test-auth.ts).
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db, schema } from '@/db';

export const SESSION_COOKIE = 'educbt.session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // A school day, not a fortnight.
export const PENDING_MAX_AGE_SECONDS = 60 * 15; // Staged 2FA: ample, but short-lived.

export type PendingUser = {
  id: number;
  schoolId: number | null;
  role: string;
  loginId: string;
};

export type SessionUser = {
  id: number;
  schoolId: number | null;
  role: string;
  loginId: string;
  mustChangePassword: boolean;
  staffId: number | null;
  studentId: number | null;
};

/** Raw token (cookie value) → hex digest (sessions.id). Never store the raw. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a session row and return the RAW token for the cookie.
 * Opportunistically purges expired rows — cheap, keeps the table tidy.
 */
export async function createSession(
  userId: number,
  ip: string | null,
  userAgent: string | null,
  options?: { pendingSecondFactor?: boolean },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const maxAge = options?.pendingSecondFactor ? PENDING_MAX_AGE_SECONDS : SESSION_MAX_AGE_SECONDS;
  const expiresAt = new Date(Date.now() + maxAge * 1000);

  await db.transaction(async (tx) => {
    await tx.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
    await tx.insert(schema.sessions).values({
      id: hashSessionToken(token),
      userId,
      expiresAt,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      totpPending: options?.pendingSecondFactor ?? false,
    });
  });

  return { token, expiresAt };
}

/**
 * Resolve a presented token to its LIVE user, or null.
 *
 * One transaction on one connection:
 *   1. read the session row (sessions is deliberately not school-scoped —
 *      the token is unguessable and this table holds no tenant data);
 *   2. bind the pre-tenant user read to this session's user via a
 *      transaction-local GUC — the session_user_lookup policy yields exactly
 *      that row and nothing else;
 *   3. re-check status and expiry against the LIVE row, so suspension,
 *      lockout and forced password changes take effect immediately;
 *   4. resolve the staff/student identity inside the same transaction, under
 *      the tenant's own RLS scope.
 */
export async function readSessionUser(token: string): Promise<SessionUser | null> {
  if (!token) return null;

  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        userId: schema.sessions.userId,
        expiresAt: schema.sessions.expiresAt,
        totpPending: schema.sessions.totpPending,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, hashSessionToken(token)))
      .limit(1);

    if (!session || session.expiresAt.getTime() <= Date.now()) return null;

    // Staged sign-in: primary credentials passed but the TOTP/recovery step
    // has not. A pending session is not a session — it authorises nothing.
    if (session.totpPending) return null;

    await tx.execute(
      sql`select set_config('app.session_user_id', ${String(session.userId)}, true)`,
    );

    const [user] = await tx
      .select({
        id: schema.users.id,
        schoolId: schema.users.schoolId,
        role: schema.users.role,
        loginId: schema.users.loginId,
        status: schema.users.status,
        mustChangePassword: schema.users.mustChangePassword,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .limit(1);

    // No row (wrong/absent GUC or stale session) or a row the school has
    // since suspended: in both cases the session is DEAD, not degraded.
    if (!user || user.status !== 'active') return null;

    await tx.execute(
      sql`select set_config('app.school_id', ${user.schoolId ? String(user.schoolId) : ''}, true)`,
    );

    // The school's status is re-read LIVE too. Suspending a school must close
    // the door for everyone in it on their NEXT request — not just at the
    // next sign-in (which hostname resolution already blocks). The read sits
    // after the tenant GUC is set, so it is bounded by the school's own
    // tenant_self policy.
    if (user.schoolId) {
      const [school] = await tx
        .select({ status: schema.schools.status })
        .from(schema.schools)
        .where(eq(schema.schools.id, user.schoolId))
        .limit(1);
      if (!school || school.status !== 'active') return null;
    }

    let staffId: number | null = null;
    let studentId: number | null = null;
    if (user.schoolId) {
      const [staffRow] = await tx
        .select({ id: schema.staff.id })
        .from(schema.staff)
        .where(eq(schema.staff.userId, user.id))
        .limit(1);
      staffId = staffRow?.id ?? null;

      const [studentRow] = await tx
        .select({ id: schema.students.id })
        .from(schema.students)
        .where(eq(schema.students.userId, user.id))
        .limit(1);
      studentId = studentRow?.id ?? null;
    }

    return {
      id: user.id,
      schoolId: user.schoolId,
      role: user.role,
      loginId: user.loginId,
      mustChangePassword: user.mustChangePassword,
      staffId,
      studentId,
    };
  });
}

/** End one session (sign out). Idempotent. */
export async function destroySession(token: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, hashSessionToken(token)));
}

/** End EVERY session for a user — a password change kills all devices. */
export async function destroyUserSessions(userId: number): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
}

/**
 * Resolve a PENDING (staged-2FA) session to the user awaiting a code.
 *
 * Returns null unless the token names a live, still-pending row — a finished
 * session or an expired staged one is not a pending sign-in. Used only by the
 * two-step verification page; it reads through the same session_user_lookup
 * GUC as readSessionUser, so it can see exactly this user and nothing else.
 */
export async function readPendingUser(token: string): Promise<PendingUser | null> {
  if (!token) return null;

  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        userId: schema.sessions.userId,
        expiresAt: schema.sessions.expiresAt,
        totpPending: schema.sessions.totpPending,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, hashSessionToken(token)))
      .limit(1);

    if (!session || !session.totpPending || session.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    await tx.execute(
      sql`select set_config('app.session_user_id', ${String(session.userId)}, true)`,
    );

    const [user] = await tx
      .select({
        id: schema.users.id,
        schoolId: schema.users.schoolId,
        role: schema.users.role,
        loginId: schema.users.loginId,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .limit(1);

    if (!user || user.status !== 'active') return null;

    return {
      id: user.id,
      schoolId: user.schoolId,
      role: user.role,
      loginId: user.loginId,
    } satisfies PendingUser;
  });
}

/**
 * Finish a staged sign-in: the code was valid, so promote the pending session
 * to a real one — clear the flag and extend the expiry to a full school day.
 * A no-op for any token that is not a live pending row, so it cannot revive
 * an expired or already-finalised session.
 */
export async function finalizePendingSession(token: string): Promise<boolean> {
  if (!token) return false;

  const rows = await db
    .update(schema.sessions)
    .set({
      totpPending: false,
      expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000),
    })
    .where(
      and(
        eq(schema.sessions.id, hashSessionToken(token)),
        eq(schema.sessions.totpPending, true),
        gt(schema.sessions.expiresAt, new Date()),
      ),
    )
    .returning({ id: schema.sessions.id });

  return rows.length > 0;
}
