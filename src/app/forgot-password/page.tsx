import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { tenantFromHost } from '@/lib/tenant';
import { requestPasswordReset, GENERIC_RESET_RESPONSE } from '@/lib/auth/recovery';

export const dynamic = 'force-dynamic';

/**
 * Password recovery request.
 *
 * The response NEVER differs by outcome (recovery.ts) — this page always says
 * the same thing. School-host requests are scoped to that school's accounts;
 * platform-host requests reach only platform-admin accounts. Accounts without
 * a recovery email are told to ask the school office, here in static text
 * that reveals nothing about any specific account.
 */
export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ done?: string }>;
}) {
  const params = await searchParams;
  const host = (await headers()).get('host');
  const school = await tenantFromHost(host);

  async function request(formData: FormData) {
    'use server';

    const h = (await headers()).get('host');
    const tenant = await tenantFromHost(h);
    // Scope follows the HOST, never the form — a request on one school's
    // host cannot fish another school's (or the platform's) accounts.
    const forwarded = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    const proto = (await headers()).get('x-forwarded-proto') ?? 'https';
    const origin = `${proto}://${(h ?? '').split(':')[0]}`;

    await requestPasswordReset({
      loginOrEmail: String(formData.get('loginOrEmail') ?? '').trim(),
      schoolId: tenant ? tenant.id : null,
      ip: forwarded,
      origin,
    });

    // Always the same destination and the same message — see recovery.ts.
    redirect('/forgot-password?done=1');
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{school ? school.name : 'EduCBT Platform'}</h1>
        <p className="sub">Forgot your password?</p>

        {params.done ? (
          <>
            <p className="notice">{GENERIC_RESET_RESPONSE}</p>
            <p className="hint">
              The link goes to the recovery email on file for the account. It
              works once and expires in 30 minutes.
            </p>
          </>
        ) : (
          <>
            <p className="hint">
              Enter the sign-in ID or the recovery email of the account. If it
              has a recovery email on file, we send a reset link there.
            </p>
            <form action={request}>
              <label htmlFor="loginOrEmail">Sign-in ID or email</label>
              <input
                id="loginOrEmail"
                name="loginOrEmail"
                type="text"
                autoComplete="username"
                required
              />
              <button type="submit">Send reset link</button>
            </form>
          </>
        )}

        <p className="hint">
          No recovery email on the account (most students)? The school office
          can issue a new password in person — ask them.
        </p>

        <p className="auth-links">
          <a href="/sign-in">Back to sign in</a>
        </p>
      </div>
    </main>
  );
}
