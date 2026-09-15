import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import { totpStatus } from '@/lib/auth/totp-account';
import { profileView, setRecoveryEmail, RecoveryEmailError } from '@/lib/auth/recovery-email';
import { changeOwnLoginId, LoginIdError } from '@/lib/auth/login-id';
import { changeOwnPassword, PasswordChangeError } from '@/lib/auth/change-password';
import { PaIcon } from '../icons';
import PasswordEyeInput from '../PasswordEyeInput';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → ACCOUNT, consolidated (correction-pass item 14): the single
 * screen that owns every account capability — sign-in ID, recovery email,
 * password, and the two-factor pointer. The dedicated routes it used to be
 * scattered across remain only where a flow NEEDS to be standalone:
 *   - /platform/account/password  — the forced mustChangePassword target
 *     (the guarded layout redirects here; moving it back into the guarded
 *     tree recreates the infinite redirect loop).
 *   - /platform/account/security  — the interactive TOTP enrollment wizard.
 * Both are linked from this screen; the capabilities are editable here.
 */
export default async function AccountSettingsPage({
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

  /** One server action per section; each redirects with its own query flag. */
  async function changeLoginId(formData: FormData) {
    'use server';
    const inner = await auth();
    if (!inner) redirect('/sign-in');
    let destination = '/platform/account';
    try {
      await changeOwnLoginId(
        { id: inner.id, schoolId: inner.schoolId, loginId: inner.loginId, role: inner.role },
        {
          newLoginId: String(formData.get('newLoginId') ?? ''),
          currentPassword: String(formData.get('currentPassword') ?? ''),
        },
      );
      destination = '/platform/account?done=id';
    } catch (error) {
      if (error instanceof LoginIdError) {
        redirect(`/platform/account?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect(destination);
  }

  async function save(formData: FormData) {
    'use server';
    const inner = await auth();
    if (!inner) redirect('/sign-in');
    let destination = '/platform/account';
    try {
      await setRecoveryEmail(
        { id: inner.id, schoolId: inner.schoolId, loginId: inner.loginId, role: inner.role },
        {
          email: String(formData.get('email') ?? ''),
          currentPassword: String(formData.get('currentPassword') ?? ''),
        },
      );
      destination = '/platform/account?done=email';
    } catch (error) {
      if (error instanceof RecoveryEmailError) {
        redirect(`/platform/account?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    redirect(destination);
  }

  async function changePassword(formData: FormData) {
    'use server';
    const inner = await auth();
    if (!inner) redirect('/sign-in');
    const next = String(formData.get('next') ?? '');
    const confirm = String(formData.get('confirm') ?? '');
    if (next !== confirm) {
      redirect(`/platform/account?error=${encodeURIComponent('The new passwords do not match.')}`);
    }
    try {
      await changeOwnPassword({ id: inner.id, schoolId: null }, String(formData.get('current') ?? ''), next);
    } catch (error) {
      redirect(
        `/platform/account?error=${encodeURIComponent(
          error instanceof PasswordChangeError ? error.message : 'The password could not be changed.',
        )}`,
      );
    }
    await signOut({ redirectTo: '/sign-in?error=Password+changed.+Please+sign+in+again.' });
  }

  return (
    <div id="platform-account-settings-view" style={{ maxWidth: 620, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Account settings</h1>
          <p>{displayName}</p>
        </div>
      </div>

      {params.error ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 16 }}>
          <PaIcon name="alert" width={15} height={15} />{params.error}
        </div>
      ) : null}
      {params.done ? (
        <div className="pa-alert pa-alert--ok" style={{ marginBottom: 16 }}>
          <PaIcon name="checkCircle" width={15} height={15} />
          {params.done === 'id' ? 'Your sign-in ID was changed. Use it next time you sign in.'
            : params.done === 'email' ? 'Your recovery email was saved.'
            : 'Saved.'}
        </div>
      ) : null}

      <div className="pa-card pa-card-pad" style={{ marginBottom: 20 }}>
        <div className="pa-detail-facts" style={{ background: 'none', border: 0, padding: 0 }}>
          <div><span>Sign-in ID</span><b>{session.loginId}</b></div>
          <div><span>Role</span><b>{session.role}</b></div>
          <div><span>Two-factor</span>
            <b>
              {twoFactor ? 'On' : 'Off'} —{' '}
              <a href="/platform/account/security" style={{ color: 'var(--pa-emerald-700)', fontWeight: 650 }}>manage</a>
            </b>
          </div>
        </div>
      </div>

      <div className="pa-glass pa-form-card" style={{ marginBottom: 20 }}>
        <div className="pa-form-section-head">
          <PaIcon name="userCheck" width={18} height={18} />
          <h2>Sign-in ID</h2>
        </div>

        <form action={changeLoginId}>
          <div className="pa-field">
            <label htmlFor="newLoginId">New sign-in ID</label>
            <input
              id="newLoginId"
              name="newLoginId"
              type="text"
              defaultValue=""
              placeholder="e.g. o.amusan"
              maxLength={191}
              className="pa-input pa-num"
              required
            />
            <p className="pa-field-hint">What you type at sign-in — letters, numbers, dots, hyphens or slashes. Active sessions pick it up immediately.</p>
          </div>
          <div className="pa-field">
            <label htmlFor="loginIdPassword">Current password</label>
            <PasswordEyeInput id="loginIdPassword" name="currentPassword" autoComplete="current-password" required />
          </div>
          <button type="submit" className="pa-btn pa-btn--primary">Change sign-in ID</button>
        </form>
      </div>

      <div className="pa-glass pa-form-card" style={{ marginBottom: 20 }}>
        <div className="pa-form-section-head">
          <PaIcon name="mail" width={18} height={18} />
          <h2>Recovery email</h2>
        </div>

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
            <PasswordEyeInput id="currentPassword" name="currentPassword" autoComplete="current-password" required />
          </div>

          <button type="submit" className="pa-btn pa-btn--primary">{email ? 'Change email' : 'Save email'}</button>
        </form>

        <p className="pa-field-hint" style={{ marginTop: 14 }}>
          Password-reset requests are queued to this address. Outbound email is not
          switched on in the pilot yet — queued messages go out as soon as delivery
          is configured, so don&rsquo;t rely on a reset email reaching this inbox today.
          Clear the field to remove it — then only an owner-level recovery procedure applies.
        </p>
      </div>

      <div className="pa-glass pa-form-card" style={{ marginBottom: 20 }}>
        <div className="pa-form-section-head">
          <PaIcon name="key" width={18} height={18} />
          <h2>Password</h2>
        </div>

        <form action={changePassword}>
          <div className="pa-field">
            <label htmlFor="current">Current password</label>
            <PasswordEyeInput id="current" name="current" autoComplete="current-password" required />
          </div>
          <div className="pa-field">
            <label htmlFor="next">New password</label>
            <PasswordEyeInput id="next" name="next" autoComplete="new-password" minLength={8} required />
          </div>
          <div className="pa-field">
            <label htmlFor="confirm">Confirm new password</label>
            <PasswordEyeInput id="confirm" name="confirm" autoComplete="new-password" minLength={8} required />
            <p className="pa-field-hint">At least 8 characters. You will be signed out of all devices afterwards.</p>
          </div>
          <button type="submit" className="pa-btn pa-btn--primary">Save password</button>
        </form>
      </div>

      <div className="pa-glass pa-form-card">
        <div className="pa-form-section-head">
          <PaIcon name="shield" width={18} height={18} />
          <h2>Two-factor authentication</h2>
        </div>
        <p className="pa-form-section-hint">
          Two-factor is {twoFactor ? 'on' : 'off'} for this account. Enrolment, recovery codes and disabling run on the security page.
        </p>
        <a href="/platform/account/security" className="pa-btn pa-btn--outline">
          <PaIcon name="shield" width={14} height={14} /> Manage two-factor
        </a>
      </div>
    </div>
  );
}
