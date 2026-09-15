import { requirePlatformSession } from '@/lib/platform/session';
import { schoolsCount } from '@/lib/platform/schools';
import { signOut } from '@/lib/auth';
import PlatformShell from './PlatformShell';
import './platform-shell.css';
import { montserrat } from './font';

/**
 * The platform administration shell.
 *
 * This is NOT a school portal. A platform admin owns no school, so nothing
 * under /portal can apply to them — and no school user can ever reach here:
 * requirePlatformSession refuses every role except platform_admin, on the
 * server, for every page beneath this layout. Typing /platform/schools/1 into
 * the address bar is exactly as useless for a principal as clicking a link to it.
 *
 * Like the portal layout: dynamic at the LAYOUT level so no page beneath can
 * ever be cached — platform pages show tenant data.
 *
 * VISUAL REVAMP NOTE: this renders the new PlatformShell (sidebar/header/
 * mobile drawer — see ./PlatformShell.tsx and ./platform-shell.css). Nothing
 * about the session guard, the sign-out mechanism, or the pages it wraps
 * changed — `endSession` is the exact same server action the old inline
 * layout used.
 */
export const dynamic = 'force-dynamic';

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePlatformSession();
  const count = await schoolsCount(actor);

  async function endSession() {
    'use server';
    await signOut({ redirectTo: '/sign-in' });
  }

  return (
    <PlatformShell loginId={actor.loginId} schoolsCount={count} endSession={endSession} fontClassName={montserrat.variable}>
      {children}
    </PlatformShell>
  );
}
