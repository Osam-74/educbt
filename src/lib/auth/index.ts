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
  createSession,
  readSessionUser,
  destroySession,
  type SessionUser,
} from '@/lib/auth/session-store';
import { authenticateCredentials, type SignInInput } from '@/lib/auth/credentials';

export type { SessionUser };

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
 * Throws Error with a user-safe message on any failure.
 */
export async function signIn(input: SignInInput): Promise<SessionUser> {
  const user = await authenticateCredentials(input);

  const h = await headers();
  const { token, expiresAt } = await createSession(
    user.id,
    input.ip ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    h.get('user-agent') ?? null,
  );

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: expiresAt,
  });

  return user;
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
