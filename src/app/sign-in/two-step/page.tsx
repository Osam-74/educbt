import PendingButton from '@/app/PendingButton';
import { redirect } from 'next/navigation';
import { auth, completeStagedSignIn, pendingSignIn, signOut } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Stage 2 of a staged sign-in — shown ONLY to an account whose primary
 * credentials already passed. The sign-in page never mentions authenticator
 * codes to anyone else, so which accounts have two-factor is not learnable
 * from outside.
 *
 * A pending session authorises nothing (session-store.ts): this page renders
 * only while the cookie names a live PENDING row; the session is promoted by
 * completeStagedSignIn() only after a valid code.
 */
export default async function TwoStepPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;

  // A completed session has no business here.
  const session = await auth();
  if (session) redirect(session.role === 'platform_admin' ? '/platform' : '/portal');

  const pending = await pendingSignIn();
  if (!pending) redirect('/sign-in');

  async function verify(formData: FormData) {
    'use server';

    // redirect() must stay OUT of the try block: NEXT_REDIRECT is an Error
    // and would be re-labelled as a verification failure by the catch.
    let destination: string | null = null;
    try {
      const result = await completeStagedSignIn(String(formData.get('code') ?? '').trim());
      destination = result
        ? (result.user.role === 'platform_admin' ? '/platform' : '/portal')
        : '/sign-in';
    } catch (error) {
      if (error instanceof Error && error.message) {
        redirect(`/sign-in/two-step?error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }

    redirect(destination ?? '/sign-in');
  }

  async function cancel() {
    'use server';
    await signOut({ redirectTo: '/sign-in' });
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>Two-step verification</h1>
        <p className="sub">Enter the 6-digit code from your authenticator app.</p>

        {params.error ? <p className="error">{params.error}</p> : null}

        <form action={verify}>
          <label htmlFor="code">Authenticator code</label>
          <input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            autoFocus
            required
          />
          <PendingButton pendingLabel="Verifying…">Verify</PendingButton>
        </form>

        <details className="recovery-details">
          <summary>Lost your authenticator? Use a recovery code</summary>
          <form action={verify}>
            <label htmlFor="rcode">Recovery code</label>
            <input
              id="rcode"
              name="code"
              type="text"
              autoComplete="off"
              placeholder="XXXXX-XXXXX"
              required
            />
            <PendingButton pendingLabel="Verifying…">Use recovery code</PendingButton>
          </form>
        </details>

        <p className="auth-links">
          <form action={cancel}>
            <PendingButton className="linklike" pendingLabel="Signing out…">Cancel and sign out</PendingButton>
          </form>
        </p>
      </div>
    </main>
  );
}
