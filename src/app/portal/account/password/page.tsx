import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import { changeOwnPassword, PasswordChangeError } from '@/lib/auth/change-password';

export const dynamic = 'force-dynamic';

/**
 * School-portal password change, now running on the shared service
 * (src/lib/auth/change-password.ts) that also serves platform accounts.
 * Same rules as before: current password verified even on a forced change,
 * every other session destroyed afterwards.
 */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (!session) redirect('/sign-in');

  const forced = session.mustChangePassword;

  async function change(formData: FormData) {
    'use server';

    const inner = await auth();

    if (!inner) redirect('/sign-in');

    const current = String(formData.get('current') ?? '');
    const next = String(formData.get('next') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    const fail = (msg: string) =>
      redirect(`/portal/account/password?error=${encodeURIComponent(msg)}`);

    if (next !== confirm) fail('The new passwords do not match.');

    try {
      await changeOwnPassword({ id: inner.id, schoolId: inner.schoolId }, current, next);
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
            ? 'Your school issued you a temporary password. Choose your own to continue.'
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

        {['principal', 'vice_principal', 'exam_officer', 'teacher'].includes(session.role) ? (
          <p className="hint">
            <a href="/portal/account/security">Two-factor security (authenticator app)</a>
          </p>
        ) : null}
      </div>
    </main>
  );
}
