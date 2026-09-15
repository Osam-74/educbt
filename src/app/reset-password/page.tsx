import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { resetPasswordWithToken } from '@/lib/auth/recovery';

export const dynamic = 'force-dynamic';

/**
 * Consume a reset token and choose a new password. The token is the ONLY
 * credential here — no session is involved (this page is reachable while
 * signed out, which is the point). A successful reset revoked every existing
 * session for the account (recovery.ts), so the next sign-in is fresh.
 *
 * Errors are generic by policy (recovery.ts): a used, expired or wrong token
 * all read the same way, so links cannot be probed for validity.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string; done?: string }>;
}) {
  const params = await searchParams;

  async function reset(formData: FormData) {
    'use server';

    const forwarded = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';

    const outcome = await resetPasswordWithToken(
      String(formData.get('token') ?? ''),
      String(formData.get('password') ?? ''),
      forwarded,
    );

    if (!outcome.ok) {
      redirect(`/reset-password?token=${encodeURIComponent(String(formData.get('token') ?? ''))}&error=${encodeURIComponent(outcome.error)}`);
    }

    redirect('/sign-in?notice=reset');
  }

  if (!params.token) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Reset your password</h1>
          <p className="sub">This link is missing its key. Request a new one.</p>
          <p className="auth-links">
            <a href="/forgot-password">Forgot password</a>
          </p>
        </div>
      </main>
    );
  }

  if (params.done) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Reset your password</h1>
          <p className="notice">Done. Sign in with your new password.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Reset your password</h1>
        <p className="sub">Choose a new password for your account.</p>

        {params.error ? <p className="error">{params.error}</p> : null}

        <form action={reset}>
          <input type="hidden" name="token" value={params.token} />

          <label htmlFor="password">New password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />

          <button type="submit">Set new password</button>
        </form>

        <p className="hint">
          Every other signed-in device will be signed out, and the link stops
          working the moment it is used.
        </p>
      </div>
    </main>
  );
}
