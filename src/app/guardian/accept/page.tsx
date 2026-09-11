import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { tenantFromHost } from '@/lib/tenant';
import { forSchool, schema } from '@/db';
import { GuardianAcceptError, acceptGuardianInvite } from '@/lib/people/guardians';

// Public, token-gated, per-hostname: never cached.
export const dynamic = 'force-dynamic';

/**
 * Guardian invite redemption — the second half of linkGuardian.
 *
 * The office issues a one-time token and hands it to the parent out of band.
 * The parent follows the link, chooses their OWN password (the school never
 * sees it), and a parent account is created and linked. The token is the
 * capability; the hostname resolves the school, exactly like the sign-in page.
 */
export default async function GuardianAcceptPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; error?: string }>;
}) {
  const params = await searchParams;
  const token = (params.t ?? '').trim();

  const host = (await headers()).get('host');
  const school = await tenantFromHost(host);

  // No school at this hostname: nothing to redeem an invitation against.
  if (!school) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Invitation</h1>
          <p className="sub">This address is not a school portal.</p>
        </div>
      </main>
    );
  }

  async function accept(formData: FormData) {
    'use server';

    const t = String(formData.get('t') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    if (password !== confirm) {
      redirect(`/guardian/accept?t=${encodeURIComponent(t)}&error=${encodeURIComponent('The two passwords do not match.')}`);
    }

    try {
      await acceptGuardianInvite(school!.id, t, password);
    } catch (error) {
      if (error instanceof GuardianAcceptError) {
        redirect(`/guardian/accept?t=${encodeURIComponent(t)}&error=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }

    redirect('/sign-in?notice=guardian-accepted');
  }

  // Show who the invitation is for. The token is the capability, like a photo
  // token: whoever holds it may see the name attached to it.
  let invitedName: string | null = null;
  if (token) {
    invitedName = await forSchool(school.id, async (tx) => {
      const [guardian] = await tx
        .select({ fullName: schema.guardians.fullName, inviteStatus: schema.guardians.inviteStatus })
        .from(schema.guardians)
        .where(eq(schema.guardians.inviteToken, token))
        .limit(1);
      return guardian && guardian.inviteStatus !== 'accepted' ? guardian.fullName : null;
    });
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{school.name}</h1>
        <p className="sub">Accept your parent portal invitation</p>

        {params.error ? <p className="error">{params.error}</p> : null}

        {!token ? (
          <p className="muted">This invitation link is incomplete. Ask the school office for the full link.</p>
        ) : invitedName ? (
          <>
            <p>
              Welcome, <strong>{invitedName}</strong>. Choose a password for your account — you
              will sign in with your email address and this password.
            </p>

            <form action={accept}>
              <input type="hidden" name="t" value={token} />

              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />

              <label htmlFor="confirm">Confirm password</label>
              <input
                id="confirm"
                name="confirm"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />

              <button type="submit">Create my account</button>
            </form>
          </>
        ) : (
          <p className="muted">
            This invitation link is not valid. Ask the school office for a new invitation.
          </p>
        )}
      </div>
    </main>
  );
}
