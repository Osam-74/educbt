/**
 * Platform-admin session helpers.
 *
 * The platform area (/platform) manages TENANTS. It is a separate world from a
 * school's portal: a platform admin owns no school, so nothing under
 * /portal can ever apply to them, and no school user may ever land here.
 *
 * These guards are the ROUTE-level layer. Every service in
 * src/lib/platform/schools.ts re-checks the role before touching the
 * database — hiding a link is presentation, not authorisation.
 */

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export type PlatformActor = {
  userId: number;
  loginId: string;
  /** Verified against the live session row by requirePlatformSession(). */
  role: 'platform_admin';
};

/**
 * The signed-in platform administrator, or null (not signed in, or a school
 * user whose session is perfectly valid for /portal and worthless here).
 */
export async function currentPlatformActor(): Promise<PlatformActor | null> {
  const user = await auth();

  if (!user || user.role !== 'platform_admin') return null;

  return { userId: user.id, loginId: user.loginId, role: 'platform_admin' as const };
}

/**
 * Route guard for every /platform page: signed in AND a platform admin.
 * School users are sent back to their own portal rather than shown a dead
 * end — the page they were reaching for does not exist for them.
 */
export async function requirePlatformSession(): Promise<PlatformActor> {
  const user = await auth();

  if (!user) redirect('/sign-in');

  if (user.role !== 'platform_admin') redirect('/portal');

  // A fresh platform account (or one reset by the owner) must set its own
  // password before it can administer anything.
  if (user.mustChangePassword) redirect('/platform/account/password');

  return { userId: user.id, loginId: user.loginId, role: 'platform_admin' as const };
}
