import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import QRCode from 'qrcode';
import { auth } from '@/lib/auth';
import {
  TotpError,
  confirmTotpEnrollment,
  disableTotp,
  pendingEnrollment,
  regenerateRecoveryCodes,
  recoveryCodesRemaining,
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
  // Scanning is how real people do this — the QR is generated server-side
  // from the otpauth URI so no QR library ships to the browser, and the
  // manual key stays available for the apps that cannot scan.
  const pendingQr = pending ? await QRCode.toDataURL(pending.uri, { margin: 1, width: 256 }) : null;
  const remaining = enabled
    ? await recoveryCodesRemaining({ id: session.id, schoolId: session.schoolId })
    : 0;

  // One-time recovery-code display: the confirm/regenerate action parks the
  // plaintext codes in a short-lived httpOnly cookie (never the URL) and this
  // read is the only other thing that sees them. Refreshing re-reads the same
  // cookie for the next two minutes, then it is gone for good.
  const flash = (await cookies()).get('educbt.new_recovery_codes')?.value;
  let newCodes: string[] | null = null;
  if (flash) {
    try {
      const parsed = JSON.parse(flash);
      if (Array.isArray(parsed)) newCodes = parsed.filter((c) => typeof c === 'string');
    } catch {
      newCodes = null;
    }
  }

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
      const { recoveryCodes } = await confirmTotpEnrollment({ id: inner.id, schoolId: inner.schoolId }, code);
      // Plaintext exists ONCE: parked in a httpOnly flash cookie for this
      // page to show, never in the URL, logs, or the database.
      (await cookies()).set('educbt.new_recovery_codes', JSON.stringify(recoveryCodes), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 120,
      });
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

  async function regenerate(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    const code = String(formData.get('code') ?? '').trim();

    try {
      const codes = await regenerateRecoveryCodes({ id: inner.id, schoolId: inner.schoolId }, code);
      (await cookies()).set('educbt.new_recovery_codes', JSON.stringify(codes), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 120,
      });
    } catch (error) {
      const msg = error instanceof TotpError ? error.message : 'The codes could not be regenerated.';
      redirect(`/portal/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/portal/account/security?done=enabled');
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
        {params.done === 'enabled' && !newCodes ? (
          <p className="ok">Two-factor is on. Keep your authenticator safe — turning this off later needs a valid code.</p>
        ) : null}

        {newCodes ? (
          <>
            <p className="ok">Two-factor is on. Save these one-time recovery codes now — this is the only time they are shown.</p>
            <p className="hint">
              Each code works once at sign-in instead of an authenticator code (it also asks you to set a
              new password). Keep them somewhere safe — paper, not your phone.
            </p>
            <ul className="recovery-codes">
              {newCodes.map((c) => (
                <li key={c}><code>{c}</code></li>
              ))}
            </ul>
          </>
        ) : enabled ? (
          <p className="hint">
            {remaining > 0
              ? `${remaining} unused recovery code${remaining === 1 ? '' : 's'} remain.`
              : 'No unused recovery codes remain — if you lose your authenticator, only the school office can get you back in.'}
          </p>
        ) : null}
        {params.done === 'disabled' ? (
          <p className="ok">Two-factor is off. Your password is the only gate again.</p>
        ) : null}

        {enabled ? (
          <>
            <form action={disable}>
              <label htmlFor="code">Code from your authenticator</label>
              <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required />

              <button type="submit">Turn off two-factor</button>
            </form>

            <details className="recovery-details">
              <summary>Regenerate recovery codes (invalidates the old ones)</summary>
              <form action={regenerate}>
                <label htmlFor="rcode">Code from your authenticator</label>
                <input id="rcode" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required />
                <button type="submit">Generate new codes</button>
              </form>
            </details>
          </>
        ) : pending ? (
          <>
            <p><strong>1.</strong> In your authenticator app, choose “Add account”, then scan this code:</p>
            {pendingQr ? (
              // eslint-disable-next-line @next/next/no-img-element -- data URL, not a remote asset
              <p className="totp-qr"><img src={pendingQr} alt="Two-factor setup code for your authenticator app" width={256} height={256} /></p>
            ) : null}

            <details className="totp-manual">
              <summary>Can&rsquo;t scan? Enter the key manually</summary>
              <p className="totp-secret">{pending.secret}</p>
              <p className="hint">If your app asks for it: type <em>Time-based</em>, <em>6 digits</em>, <em>30 seconds</em>.</p>
            </details>

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
