import { redirect } from 'next/navigation';
import PendingButton from '@/app/PendingButton';
import { auth } from '@/lib/auth';
import { totpStatus } from '@/lib/auth/totp-account';
import {
  profileView,
  setRecoveryEmail,
  RecoveryEmailError,
} from '@/lib/auth/recovery-email';

export const dynamic = 'force-dynamic';

/**
 * Account profile: who you are on this platform, and the recovery email that
 * password-reset links are sent to. The email is OPTIONAL — students in
 * particular usually have none — and setting or changing it requires the
 * current password, because whoever controls the address can reset the
 * password (recovery.ts).
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();
  if (!session) redirect('/sign-in');

  const account = { id: session.id, schoolId: session.schoolId, role: session.role, loginId: session.loginId };
  const { displayName, email, emailVerified } = await profileView(account);
  const { enabled: twoFactor } = await totpStatus(account);

  async function save(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    // redirect() must stay OUT of the try block (NEXT_REDIRECT is an Error).
    let destination = '/portal/account/profile';
    try {
      await setRecoveryEmail(
        { id: inner.id, schoolId: inner.schoolId, loginId: inner.loginId, role: inner.role },
        {
          email: String(formData.get('email') ?? ''),
          currentPassword: String(formData.get('currentPassword') ?? ''),
        },
      );
      destination = '/portal/account/profile?done=1';
    } catch (error) {
      if (error instanceof RecoveryEmailError) {
        redirect(`/portal/account/profile?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }

    redirect(destination);
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Your account</h1>
        <p className="sub">{displayName}</p>

        <table className="kv">
          <tbody>
            <tr><th>Sign-in ID</th><td>{session.loginId}</td></tr>
            <tr><th>Role</th><td>{session.role}</td></tr>
            <tr>
              <th>Two-factor</th>
              <td>{twoFactor ? 'On' : 'Off'} — <a href="/portal/account/security">manage</a></td>
            </tr>
          </tbody>
        </table>

        <h2>Recovery email</h2>
        {params.error ? <p className="error">{params.error}</p> : null}
        {params.done ? <p className="ok">Saved.</p> : null}

        <form action={save}>
          <label htmlFor="email">
            Email address {email && !emailVerified ? <span className="muted">(unverified)</span> : null}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            defaultValue={email ?? ''}
            placeholder="you@example.com — optional"
            maxLength={320}
          />

          <label htmlFor="currentPassword">Current password</label>
          <input
            id="currentPassword"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
          />

          <PendingButton pendingLabel="Saving…">{email ? 'Change email' : 'Save email'}</PendingButton>
        </form>

        <p className="hint">
          Password-reset requests are queued to this address. Outbound email is not
          switched on yet — queued messages go out as soon as delivery is configured,
          so don&rsquo;t rely on a reset email reaching this inbox today. Clear the field
          to remove it — then only the school office can recover your account.
        </p>

        <p className="auth-links">
          <a href="/portal/account/security">Security</a> · <a href="/portal/account/password">Password</a>
        </p>
      </div>
    </main>
  );
}
