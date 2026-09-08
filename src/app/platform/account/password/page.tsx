import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import { changeOwnPassword, PasswordChangeError } from '@/lib/auth/change-password';

export const dynamic = 'force-dynamic';

/**
 * Platform-account password change — the /platform counterpart of
 * /portal/account/password, running on the same shared service. Reached by
 * any platform admin whose password is still the issued temporary one.
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
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{forced ? 'Set your password' : 'Change your password'}</h1>
        <p className="sub">
          {forced
            ? 'Your account was created with a temporary password. Choose your own to continue.'
            : 'You will be signed out of all devices afterwards.'}
        </p>

        {params.error ? <p className="error">{params.error}</p> : null}

        <form action={change}>
          <label htmlFor="current">Current password</label>
          <input id="current" name="current" type="password" autoComplete="current-password" required />

          <label htmlFor="next">New password</label>
          <input id="next" name="next" type="password" autoComplete="new-password" minLength={8} required />

          <label htmlFor="confirm">Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />

          <button type="submit">Save password</button>
        </form>
      </div>
    </main>
  );
}
