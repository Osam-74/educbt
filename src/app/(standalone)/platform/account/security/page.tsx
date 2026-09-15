import { cookies } from 'next/headers';
import QRCode from 'qrcode';
import { redirect } from 'next/navigation';
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
 * Platform-admin two-factor enrollment — the /platform counterpart of
 * /portal/account/security on the same services (totp-account handles a null
 * schoolId via the platform-admin policies).
 *
 * PLACEMENT: this page deliberately lives in src/app/(standalone)/… so the
 * guarded platform layout does not wrap it (see the password page note).
 * The URL is unchanged.
 */
export default async function PlatformSecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (!session) redirect('/sign-in');
  if (session.role !== 'platform_admin') redirect('/portal');

  const account = { id: session.id, schoolId: session.schoolId };

  const { enabled } = await totpStatus(account);
  const pending = enabled ? null : await pendingEnrollment(account);
  // Scanning beats typing — server-side QR from the otpauth URI.
  const pendingQr = pending ? await QRCode.toDataURL(pending.uri, { margin: 1, width: 256 }) : null;
  const remaining = enabled ? await recoveryCodesRemaining(account) : 0;

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
    if (!inner || inner.role !== 'platform_admin') redirect('/sign-in');

    try {
      await startTotpEnrollment({ id: inner.id, schoolId: inner.schoolId });
    } catch (error) {
      const msg = error instanceof TotpError ? error.message : 'The setup could not start.';
      redirect(`/platform/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/platform/account/security');
  }

  async function confirm(formData: FormData) {
    'use server';

    const inner = await auth();
    if (!inner) redirect('/sign-in');

    const code = String(formData.get('code') ?? '').trim();

    try {
      const { recoveryCodes } = await confirmTotpEnrollment(
        { id: inner.id, schoolId: inner.schoolId },
        code,
      );
      (await cookies()).set('educbt.new_recovery_codes', JSON.stringify(recoveryCodes), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 120,
      });
    } catch (error) {
      const msg = error instanceof TotpError ? error.message : 'The code could not be verified.';
      redirect(`/platform/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/platform/account/security?done=enabled');
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
      redirect(`/platform/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/platform/account/security?done=disabled');
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
      redirect(`/platform/account/security?error=${encodeURIComponent(msg)}`);
    }

    redirect('/platform/account/security?done=enabled');
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Platform account security</h1>
        <p className="sub">
          {enabled
            ? 'Your sign-in asks for a code from your authenticator app.'
            : 'A platform-admin account can reach every school. A password alone is not enough.'}
        </p>

        {params.error ? <p className="error">{params.error}</p> : null}

        {newCodes ? (
          <>
            <p className="ok">Two-factor is on. Save these one-time recovery codes now — this is the only time they are shown.</p>
            <p className="hint">
              Each code works once at sign-in instead of an authenticator code (it also asks you to set a
              new password).
            </p>
            <ul className="recovery-codes">
              {newCodes.map((c) => (
                <li key={c}><code>{c}</code></li>
              ))}
            </ul>
          </>
        ) : params.done === 'enabled' ? (
          <p className="ok">Two-factor is on. Keep your authenticator safe — turning this off later needs a valid code.</p>
        ) : null}
        {params.done === 'disabled' ? (
          <p className="ok">Two-factor is off. Your password is the only gate again.</p>
        ) : null}

        {enabled ? (
          <>
            <p className="hint">
              {remaining > 0
                ? `${remaining} unused recovery code${remaining === 1 ? '' : 's'} remain.`
                : 'No unused recovery codes remain — losing your authenticator means an owner-level recovery procedure.'}
            </p>
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

        <p><a href="/platform/account/password">Back to password</a></p>
      </div>
    </main>
  );
}
