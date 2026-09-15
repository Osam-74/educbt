import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import { changeOwnPassword, PasswordChangeError } from '@/lib/auth/change-password';
import '@/app/platform/platform-shell.css';
import { PaIcon } from '@/app/platform/icons';

export const dynamic = 'force-dynamic';

/**
 * Platform-account password change — the /platform counterpart of
 * /portal/account/password, running on the same shared service. Reached by
 * any platform admin whose password is still the issued temporary one.
 * PLACEMENT: this page deliberately lives in src/app/(standalone)/… so the
 * guarded layout (which forces mustChangePassword users to redirect HERE)
 * does not wrap it. Moving it back under src/app/platform/ recreates an
 * infinite redirect loop: layout -> requirePlatformSession -> redirect to
 * this page -> layout -> … The URL is unchanged.
 *
 * VISUAL REVAMP ONLY: reskinned with the platform-admin forest-green card
 * style (same design tokens as the shell, imported directly since this
 * route intentionally sits outside the shell's layout). The `change` server
 * action, its field names, and the sign-out-after-change behavior are
 * byte-for-byte the same as before — this file only changed JSX/classNames.
 */
export default async function PlatformChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (!session) redirect('/sign-in');
  if (session.role !== 'platform_admin') redirect('/portal');

  const forced = session.mustChangePassword;

  async function change(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner || inner.role !== 'platform_admin') redirect('/sign-in');

    const current = String(formData.get('current') ?? '');
    const next = String(formData.get('next') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    const fail = (msg: string) =>
      redirect(`/platform/account/password?error=${encodeURIComponent(msg)}`);

    if (next !== confirm) fail('The new passwords do not match.');

    try {
      await changeOwnPassword({ id: inner.id, schoolId: null }, current, next);
    } catch (error) {
      fail(error instanceof PasswordChangeError ? error.message : 'The password could not be changed.');
    }

    await signOut({ redirectTo: '/sign-in?error=Password+changed.+Please+sign+in+again.' });
  }

  return (
    <div className="pa-shell" style={{ display: 'block', minHeight: '100dvh' }}>
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24 }}>
        <div className="pa-glass pa-form-card" style={{ width: '100%', maxWidth: 420 }}>
          <div className="pa-form-section-head" style={{ marginBottom: 4 }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--pa-emerald-100)', color: 'var(--pa-emerald-900)', display: 'grid', placeItems: 'center' }}>
              <PaIcon name="lock" width={19} height={19} />
            </span>
            <h2>{forced ? 'Set your password' : 'Change your password'}</h2>
          </div>
          <p className="pa-form-section-hint" style={{ marginBottom: 18 }}>
            {forced
              ? 'Your account was created with a temporary password. Choose your own to continue.'
              : 'You will be signed out of all devices afterwards.'}
          </p>

          {params.error ? <div className="pa-alert pa-alert--error"><PaIcon name="alert" width={15} height={15} />{params.error}</div> : null}

          <form action={change}>
            <div className="pa-field">
              <label htmlFor="current">Current password</label>
              <input id="current" name="current" type="password" autoComplete="current-password" required className="pa-input" />
            </div>

            <div className="pa-field">
              <label htmlFor="next">New password</label>
              <input id="next" name="next" type="password" autoComplete="new-password" minLength={8} required className="pa-input" />
            </div>

            <div className="pa-field">
              <label htmlFor="confirm">Confirm new password</label>
              <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required className="pa-input" />
              <p className="pa-field-hint">At least 8 characters.</p>
            </div>

            <button type="submit" className="pa-btn pa-btn--primary pa-btn--block">Save password</button>
          </form>
        </div>
      </main>
    </div>
  );
}
