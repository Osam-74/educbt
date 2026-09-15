/**
 * Authentication surface — sign in, read session, sign out.
 *
 * The strategy is fixed in stone, not configurable: rows in the sessions
 * table, an unguessable hashed token in an httpOnly cookie, and the LIVE
 * user row re-read on every request. A suspended student must lose access
 * on their next request; a signed JWT would keep them in until expiry, which
 * during an examination is precisely wrong. (Auth.js's Credentials flow
 * only ever issues JWTs, which is why the session layer is ours — see
 * session-store.ts.)
 *
 * This file is the only place that touches cookies; session-store.ts is the
 * only place that touches the sessions table; credentials.ts owns the
 * decision. Everything downstream reads the tenant from the SESSION, never
 * from a URL or form field.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  PENDING_MAX_AGE_SECONDS,
  createSession,
  readSessionUser,
  readPendingUser,
  finalizePendingSession,
  destroySession,
  type SessionUser,
  type PendingUser,
} from '@/lib/auth/session-store';
import {
  authenticateCredentials,
  verifySecondFactor,
  type SignInInput,
  type SecondFactorInput,
} from '@/lib/auth/credentials';

export type { SessionUser, PendingUser, SecondFactorInput };

/**
 * The current signed-in user, or null. This is what every guard builds on.
 * Re-reads the LIVE row — status, lockout, forced password change — so it
 * cannot go stale between requests.
 */
export async function auth(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return readSessionUser(token);
}

/**
 * Verify credentials, create the session row, and set the cookie.
 *
 * For a two-factor account the row is created PENDING — it authorises
 * nothing until completeStagedSignIn() verifies the code. The caller learns
 * this from secondFactorRequired and sends the user to /sign-in/two-step.
 * Throws Error with a user-safe message on any failure.
 */
export async function signIn(input: SignInInput): Promise<{
  user: SessionUser;
  secondFactorRequired: boolean;
}> {
  const { user, secondFactorRequired } = await authenticateCredentials(input);

  // Production-build server actions on Next 15.1 can lose the request scope,
  // making headers() throw (`\`headers\` was called outside a request scope`).
  // The IP and user-agent are audit colour, not credentials — degrade to null
  // rather than refuse sign-in entirely. Cookies still bind the session.
  let forwardedFor: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    forwardedFor = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    userAgent = h.get('user-agent') ?? null;
  } catch {
    // outside request scope — fall through with null audit metadata
  }
  const { token, expiresAt } = await createSession(
    user.id,
    input.ip ?? forwardedFor,
    userAgent,
    { pendingSecondFactor: secondFactorRequired },
  );

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: secondFactorRequired ? PENDING_MAX_AGE_SECONDS : SESSION_MAX_AGE_SECONDS,
    expires: expiresAt,
  });

  return { user, secondFactorRequired };
}

/**
 * Stage 2 of a staged sign-in: read the pending session the cookie points
 * at, verify the code, then promote the row to a real session. Returns null
 * when the cookie names no live pending sign-in (expired, finished, or an
 * ordinary session) — callers bounce to /sign-in rather than leak why.
 * Throws Error with a user-safe message on a wrong/locked/throttled code.
 */
export async function completeStagedSignIn(code: string): Promise<{
  user: SessionUser;
  recoveryCodeUsed: boolean;
} | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const pending = await readPendingUser(token);
  if (!pending) return null;

  const { user, recoveryCodeUsed } = await verifySecondFactor(
    {
      userId: pending.id,
      schoolId: pending.schoolId,
      loginId: pending.loginId,
    },
    code,
  );

  const promoted = await finalizePendingSession(token);
  if (!promoted) return null; // expired between the read and the write

  return { user, recoveryCodeUsed };
}

/** The account awaiting a code, for rendering the stage-2 page. */
export async function pendingSignIn(): Promise<PendingUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return readPendingUser(token);
}

/**
 * End the presented session and clear the cookie. The redirect target is
 * included so callers cannot forget it: a signed-out user must never land
 * back on a protected page.
 */
export async function signOut(options?: { redirectTo?: string }): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await destroySession(token);

  store.delete(SESSION_COOKIE);

  if (options?.redirectTo) redirect(options.redirectTo);
}
