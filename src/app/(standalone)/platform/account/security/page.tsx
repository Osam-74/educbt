import { cookies } from 'next/headers';
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
import '@/app/platform/platform-shell.css';
import { PaIcon } from '@/app/platform/icons';

export const dynamic = 'force-dynamic';

/**
 * Platform-admin two-factor enrollment — the /platform counterpart of
 * /portal/account/security on the same services (totp-account handles a null
 * schoolId via the platform-admin policies).
 *
 * PLACEMENT: this page deliberately lives in src/app/(standalone)/… so the
 * guarded platform layout does not wrap it (see the password page note).
 * The URL is unchanged.
 *
 * VISUAL REVAMP ONLY: every `action` function below (start/confirm/disable/
 * regenerate), its cookie handling, and its redirects are byte-for-byte the
 * same as before this pass — Agent 1 owns this behavior. Only the JSX
 * wrapper/classNames changed, matching the platform-admin visual language.
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
    <div className="pa-shell" style={{ display: 'block', minHeight: '100dvh' }}>
      <main style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24 }}>
        <div className="pa-glass pa-form-card" style={{ width: '100%', maxWidth: 460 }}>
          <div className="pa-form-section-head" style={{ marginBottom: 4 }}>
            <span style={{ width: 40, height: 40, borderRadius: 12, background: 'var(--pa-emerald-100)', color: 'var(--pa-emerald-900)', display: 'grid', placeItems: 'center' }}>
              <PaIcon name="shield" width={19} height={19} />
            </span>
            <h2>Platform account security</h2>
          </div>
          <p className="pa-form-section-hint" style={{ marginBottom: 18 }}>
            {enabled
              ? 'Your sign-in asks for a code from your authenticator app.'
              : 'A platform-admin account can reach every school. A password alone is not enough.'}
          </p>

          {params.error ? <div className="pa-alert pa-alert--error"><PaIcon name="alert" width={15} height={15} />{params.error}</div> : null}

          {newCodes ? (
            <>
              <div className="pa-alert pa-alert--ok"><PaIcon name="checkCircle" width={15} height={15} />Two-factor is on. Save these one-time recovery codes now — this is the only time they are shown.</div>
              <p className="pa-field-hint">
                Each code works once at sign-in instead of an authenticator code (it also asks you to set a new password).
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {newCodes.map((c) => (
                  <li key={c} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, background: 'var(--pa-stone-100)', border: '1px solid var(--pa-stone-200)', borderRadius: 8, padding: '8px 10px' }}>
                    <code>{c}</code>
                  </li>
                ))}
              </ul>
            </>
          ) : params.done === 'enabled' ? (
            <div className="pa-alert pa-alert--ok"><PaIcon name="checkCircle" width={15} height={15} />Two-factor is on. Keep your authenticator safe — turning this off later needs a valid code.</div>
          ) : null}
          {params.done === 'disabled' ? (
            <div className="pa-alert pa-alert--ok"><PaIcon name="checkCircle" width={15} height={15} />Two-factor is off. Your password is the only gate again.</div>
          ) : null}

          {enabled ? (
            <>
              <p className="pa-field-hint">
                {remaining > 0
                  ? `${remaining} unused recovery code${remaining === 1 ? '' : 's'} remain.`
                  : 'No unused recovery codes remain — losing your authenticator means an owner-level recovery procedure.'}
              </p>
              <form action={disable} className="pa-field">
                <label htmlFor="code">Code from your authenticator</label>
                <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required className="pa-input" style={{ marginBottom: 12 }} />
                <button type="submit" className="pa-btn pa-btn--danger pa-btn--block">Turn off two-factor</button>
              </form>

              <details style={{ marginTop: 16 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, fontWeight: 650, color: 'var(--pa-emerald-800)' }}>
                  Regenerate recovery codes (invalidates the old ones)
                </summary>
                <form action={regenerate} className="pa-field" style={{ marginTop: 10 }}>
                  <label htmlFor="rcode">Code from your authenticator</label>
                  <input id="rcode" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required className="pa-input" style={{ marginBottom: 12 }} />
                  <button type="submit" className="pa-btn pa-btn--outline pa-btn--block">Generate new codes</button>
                </form>
              </details>
            </>
          ) : pending ? (
            <>
              <p style={{ fontSize: 13 }}><strong>1.</strong> In your authenticator app, choose &ldquo;Add account&rdquo;, then enter this key (or choose &ldquo;enter a setup key&rdquo; / &ldquo;manual entry&rdquo;):</p>
              <p className="pa-num" style={{ fontSize: 14, background: 'var(--pa-stone-100)', border: '1px solid var(--pa-stone-200)', borderRadius: 10, padding: '10px 12px', wordBreak: 'break-all' }}>{pending.secret}</p>
              <p className="pa-field-hint">If your app asks for it: type <em>Time-based</em>, <em>6 digits</em>, <em>30 seconds</em>.</p>
              <p style={{ fontSize: 13 }}><strong>2.</strong> Enter the six-digit code the app is showing now:</p>
              <form action={confirm} className="pa-field">
                <label htmlFor="code">Current code</label>
                <input id="code" name="code" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="one-time-code" required className="pa-input" style={{ marginBottom: 12 }} />
                <button type="submit" className="pa-btn pa-btn--primary pa-btn--block">Confirm and turn on</button>
              </form>
            </>
          ) : (
            <form action={start}>
              <button type="submit" className="pa-btn pa-btn--primary pa-btn--block">Start setup</button>
            </form>
          )}

          <p style={{ marginTop: 16 }}>
            <a href="/platform/account/password" style={{ fontSize: 12.5, color: 'var(--pa-emerald-700)', fontWeight: 600, textDecoration: 'none' }}>
              &larr; Back to password
            </a>
          </p>
        </div>
      </main>
    </div>
  );
}
