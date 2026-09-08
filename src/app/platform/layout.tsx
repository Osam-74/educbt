import { requirePlatformSession } from '@/lib/platform/session';
import Link from 'next/link';
import { signOut } from '@/lib/auth';

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
 */
export const dynamic = 'force-dynamic';

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const actor = await requirePlatformSession();

  async function endSession() {
    'use server';
    await signOut({ redirectTo: '/sign-in' });
  }

  return (
    <div className="portal">
      <header className="portal__bar">
        <div>
          <strong>EduCBT Platform</strong>
          <span className="portal__who">{actor.loginId} · Platform Administrator</span>
        </div>
        <nav>
          <Link href="/platform">Dashboard</Link>
          <Link href="/platform/schools">Schools</Link>
          <Link href="/platform/schools/new">New school</Link>
          <Link href="/platform/account/password">Password</Link>
          <form action={endSession} style={{ display: 'inline' }}>
            <button type="submit" className="linkish">Sign out</button>
          </form>
        </nav>
      </header>
      <main className="portal__body">{children}</main>
    </div>
  );
}
