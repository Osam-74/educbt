import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  TotpError,
  confirmTotpEnrollment,
  disableTotp,
  pendingEnrollment,
  startTotpEnrollment,
  totpStatus,
} from '@/lib/auth/totp-account';

export const dynamic = 'force-dynamic';

/**
 * Two-factor enrollment, on the account holder's own session.
 *
 * The flow is deliberately three steps with a harmless middle state:
 *   1. Start — a secret is generated and stored, but stays DISABLED. A
 *      secret that was never confirmed changes nothing about sign-in.
 *   2. The user adds it to their authenticator (scan or type), then enters
 *      the code the app shows. A correct code flips two-factor on.
 *   3. Turning it off later requires a valid CURRENT code — a borrowed
 *      browser is not enough.
 *
 * Staff only: the roles the schema calls "can publish results or approve
 * papers" are the ones a shared staffroom password must not be enough for.
 * Students and parents keep password-only sign-in.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (!session) redirect('/sign-in');

  const STAFF_ROLES = new Set(['principal', 'vice_principal', 'exam_officer', 'teacher']);
  if (!STAFF_ROLES.has(session.role)) redirect('/portal');

  const { enabled } = await totpStatus({ id: session.id, schoolId: session.schoolId });
  const pending = enabled ? null : await pendingEnrollment({ id: session.id, schoolId: session.schoolId });

  async function start() {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    try {
      await startTotpEnrollment({ id: inner.id, schoolId: inner.schoolId });
    } catch (error) {
      const msg = error instanceof TotpError ? error.message : 'The setup could not start.';
      redirect(`/portal/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/portal/account/security');
  }

  async function confirm(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    const code = String(formData.get('code') ?? '').trim();

    try {
      await confirmTotpEnrollment({ id: inner.id, schoolId: inner.schoolId }, code);
    } catch (error) {
      const msg = error instanceof TotpError ? error.message : 'The code could not be verified.';
      redirect(`/portal/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/portal/account/security?done=enabled');
  }

  async function disable(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    const code = String(formData.get('code') ?? '').trim();

    try {
      await disableTotp({ id: inner.id, schoolId: inner.schoolId }, code);
    } catch (error) {
      const msg = error instanceof TotpError ? error.message : 'Two-factor could not be turned off.';
      redirect(`/portal/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/portal/account/security?done=disabled');
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Two-factor security</h1>
        <p className="sub">
          {enabled
            ? 'Your sign-in asks for a code from your authenticator app.'
            : 'Add your account to an authenticator app (Google Authenticator, Authy, 1Password) so a password alone is not enough to reach your account.'}
        </p>

        {params.error ? <p className="error">{params.error}</p> : null}
        {params.done === 'enabled' ? (
          <p className="ok">Two-factor is on. Keep your authenticator safe — turning this off later needs a valid code.</p>
        ) : null}
        {params.done === 'disabled' ? (
          <p className="ok">Two-factor is off. Your password is the only gate again.</p>
        ) : null}

        {enabled ? (
          <form action={disable}>
            <label htmlFor="code">Code from your authenticator</label>
            <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required />

            <button type="submit">Turn off two-factor</button>
          </form>
        ) : pending ? (
          <>
            <p><strong>1.</strong> In your authenticator app, choose “Add account”, then enter this key (or choose “enter a setup key” / “manual entry”):</p>
            <p className="totp-secret">{pending.secret}</p>

            <p className="hint">If your app asks for it: type <em>Time-based</em>, <em>6 digits</em>, <em>30 seconds</em>.</p>

            <p><strong>2.</strong> Enter the six-digit code the app is showing now:</p>

            <form action={confirm}>
              <label htmlFor="code">Current code</label>
              <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required />

              <button type="submit">Confirm and turn on</button>
            </form>
          </>
        ) : (
          <form action={start}>
            <button type="submit">Start setup</button>
          </form>
        )}

        <p className="hint">
          Lost your authenticator? The school office can reset your account the same way it issues a new password.
        </p>

        <p><a href="/portal/account/password">Back to password</a></p>
      </div>
    </main>
  );
}
