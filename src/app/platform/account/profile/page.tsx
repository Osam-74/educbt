import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { totpStatus } from '@/lib/auth/totp-account';
import {
  profileView,
  setRecoveryEmail,
  RecoveryEmailError,
} from '@/lib/auth/recovery-email';
import { PaIcon } from '../../icons';

export const dynamic = 'force-dynamic';

/**
 * Account profile: who you are on this platform, and the recovery email that
 * password-reset links are sent to. The email is OPTIONAL — students in
 * particular usually have none — and setting or changing it requires the
 * current password, because whoever controls the address can reset the
 * password (recovery.ts).
 *
 * VISUAL REVAMP ONLY: this page is now wrapped by the new PlatformShell (it
 * lives under src/app/platform/, not the (standalone) group), so it no
 * longer renders its own <main>/auth-shell — that was a nested <main>
 * before. All the recovery-email logic below is unchanged.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();
  if (!session) redirect('/sign-in');
  if (session.role !== 'platform_admin') redirect('/portal');

  const account = { id: session.id, schoolId: session.schoolId, role: session.role, loginId: session.loginId };
  const { displayName, email, emailVerified } = await profileView(account);
  const { enabled: twoFactor } = await totpStatus(account);

  async function save(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    // redirect() must stay OUT of the try block (NEXT_REDIRECT is an Error).
    let destination = '/platform/account/profile';
    try {
      await setRecoveryEmail(
        { id: inner.id, schoolId: inner.schoolId, loginId: inner.loginId },
        {
          email: String(formData.get('email') ?? ''),
          currentPassword: String(formData.get('currentPassword') ?? ''),
        },
      );
      destination = '/platform/account/profile?done=1';
    } catch (error) {
      if (error instanceof RecoveryEmailError) {
        redirect(`/platform/account/profile?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }

    redirect(destination);
  }

  return (
    <div id="platform-account-profile-view" style={{ maxWidth: 520, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Platform account</h1>
          <p>{displayName}</p>
        </div>
      </div>

      <div className="pa-card pa-card-pad" style={{ marginBottom: 20 }}>
        <div className="pa-detail-facts" style={{ background: 'none', border: 0, padding: 0 }}>
          <div><span>Sign-in ID</span><b>{session.loginId}</b></div>
          <div><span>Role</span><b>{session.role}</b></div>
          <div className="pa-span-2">
            <span>Two-factor</span>
            <b>
              {twoFactor ? 'On' : 'Off'} —{' '}
              <a href="/platform/account/security" style={{ color: 'var(--pa-emerald-700)', fontWeight: 650 }}>manage</a>
            </b>
          </div>
        </div>
      </div>

      <div className="pa-glass pa-form-card">
        <div className="pa-form-section-head">
          <PaIcon name="mail" width={18} height={18} />
          <h2>Recovery email</h2>
        </div>

        {params.error ? <div className="pa-alert pa-alert--error"><PaIcon name="alert" width={15} height={15} />{params.error}</div> : null}
        {params.done ? <div className="pa-alert pa-alert--ok"><PaIcon name="checkCircle" width={15} height={15} />Saved.</div> : null}

        <form action={save}>
          <div className="pa-field">
            <label htmlFor="email">
              Email address {email && !emailVerified ? <span className="pa-optional">(unverified)</span> : null}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue={email ?? ''}
              placeholder="you@example.com — optional"
              maxLength={320}
              className="pa-input"
            />
          </div>

          <div className="pa-field">
            <label htmlFor="currentPassword">Current password</label>
            <input
              id="currentPassword"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              className="pa-input"
            />
          </div>

          <button type="submit" className="pa-btn pa-btn--primary">{email ? 'Change email' : 'Save email'}</button>
        </form>

        <p className="pa-field-hint" style={{ marginTop: 14 }}>
          Password-reset links go here. Clear the field to remove it — then only an
          owner-level recovery procedure applies.
        </p>

        <p style={{ fontSize: 12, marginTop: 10 }}>
          <a href="/platform/account/security" style={{ color: 'var(--pa-emerald-700)', fontWeight: 600, textDecoration: 'none' }}>Security</a>
          {' · '}
          <a href="/platform/account/password" style={{ color: 'var(--pa-emerald-700)', fontWeight: 600, textDecoration: 'none' }}>Password</a>
        </p>
      </div>
    </div>
  );
}
