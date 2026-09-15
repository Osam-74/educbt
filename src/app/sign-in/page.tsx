import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { tenantFromHost } from '@/lib/tenant';
import { auth, signIn } from '@/lib/auth';
import PasswordInput from './PasswordInput';

// Never cached: the page is per-hostname and reflects session state.
export const dynamic = 'force-dynamic';

/**
 * Where a valid session already belongs.
 *
 * Platform administrators own no school, so /portal cannot serve them — and
 * its layout would bounce them straight back. Route by role instead of
 * assuming every session is a school session.
 */
function homeFor(role: string): string {
  return role === 'platform_admin' ? '/platform' : '/portal';
}

/** Is this host a tenant-shaped address (subdomain/custom domain) rather than
 *  the platform site itself? Used to give unknown tenant hosts the "no school
 *  at this address" page instead of the platform sign-in form. */
function isTenantShapedHost(host: string, platform: string): boolean {
  const clean = host.toLowerCase().split(':')[0] ?? '';
  if (!clean || !platform) return false;
  if (clean === platform || clean === `www.${platform}`) return false;
  return clean.endsWith(`.${platform}`);
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string; next?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (session) redirect(homeFor(session.role));

  const host = (await headers()).get('host');
  const school = await tenantFromHost(host);
  const platformDomain = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase();

  // A tenant-shaped address that resolves to no ACTIVE school gets a neutral
  // not-found page — never the platform sign-in, and never a reason why (an
  // unknown subdomain and a suspended school must look identical from outside).
  const hostLooksLikeTenant = isTenantShapedHost(host ?? '', platformDomain);
  if (!school && hostLooksLikeTenant) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>No school at this address</h1>
          <p className="sub">
            This address is not linked to an active school. Check the web address
            your school gave you, or contact the school office.
          </p>
          <p className="hint">
            School staff and students sign in at their school&apos;s own address —
            for example <code>schooleducbtname.{platformDomain}</code>.
          </p>
        </div>
      </main>
    );
  }

  // The hostname identifies the school. If it resolves to nothing, there is no
  // school to sign in to — so this is the PLATFORM host, and the only account
  // that can sign in here is a platform administrator (whose account owns no
  // school; see the platform_admin_lookup policy).
  if (!school) {
    async function platformSignIn(formData: FormData) {
      'use server';

      // redirect() must stay OUT of the try block: NEXT_REDIRECT is an Error
      // and would be re-labelled as a sign-in failure by the catch.
      let destination = '/platform';
      try {
        const { secondFactorRequired } = await signIn({
          loginId: String(formData.get('loginId') ?? '').trim(),
          password: String(formData.get('password') ?? ''),
          // null: the platform-admin sign-in path. The credential decision in
          // credentials.ts resolves ONLY platform-admin accounts with this.
          schoolId: null,
        });
        if (secondFactorRequired) destination = '/sign-in/two-step';
      } catch (error) {
        if (error instanceof Error && error.message) {
          redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
        }
        throw error;
      }

      redirect(destination);
    }

    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>EduCBT Platform</h1>
          <p className="sub">Platform administration sign-in</p>

          {params.error ? <p className="error">{params.error}</p> : null}

          <form action={platformSignIn}>
            <label htmlFor="loginId">Platform sign-in ID or email</label>
            <input
              id="loginId"
              name="loginId"
              type="text"
              autoComplete="username"
              required
            />

            <label htmlFor="password">Password</label>
            <PasswordInput />

            <button type="submit">Sign in</button>
          </form>

          <p className="auth-links">
            <a href="/forgot-password">Forgot password?</a>
          </p>

          <p className="hint">
            This address is not linked to a school. School staff and students
            sign in at their school&apos;s own address.
          </p>
        </div>
      </main>
    );
  }

  async function authenticate(formData: FormData) {
    'use server';

    const target = String(formData.get('next') ?? '/portal');

    // Server actions are hoisted, so TypeScript cannot narrow `school` into
    // this closure — and a defensive re-check is correct anyway.
    if (!school) redirect('/sign-in?error=School+not+found');

    // redirect() must stay OUT of the try block: NEXT_REDIRECT is an Error
    // and would be re-labelled as a sign-in failure by the catch.
    let destination = target.startsWith('/') ? target : '/portal';
    try {
      const { secondFactorRequired } = await signIn({
        loginId: String(formData.get('loginId') ?? '').trim(),
        password: String(formData.get('password') ?? ''),
        // The tenant comes from the HOSTNAME resolution in this closure —
        // never from the posted form, which a user could edit.
        schoolId: school.id,
      });
      if (secondFactorRequired) destination = '/sign-in/two-step';
    } catch (error) {
      // All expected failures throw a user-safe message (credentials.ts);
      // redirect surfaces it on the form. Anything else is a bug: rethrow.
      if (error instanceof Error && error.message) {
        redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
      }

      throw error;
    }

    redirect(destination);
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        {school.logoUrl ? (
          <img src={school.logoUrl} alt="" className="auth-logo" />
        ) : null}
        <h1>{school.name}</h1>
        <p className="sub">Sign in to continue</p>

        {params.error ? <p className="error">{params.error}</p> : null}
        {params.notice === 'guardian-accepted' ? <p className="sub">Account created. Sign in with your email address and your new password.</p> : null}
        {params.notice === 'reset' ? <p className="sub">Your password has been changed. Sign in with the new password.</p> : null}

        <form action={authenticate}>
          {/* The tenant is never posted: the server action takes the school
              from the hostname resolution in its closure, so editing anything
              in this form cannot change which school's account is used. */}
          <input type="hidden" name="next" value={params.next ?? '/portal'} />

          <label htmlFor="loginId">Admission number, staff number or email</label>
          <input
            id="loginId"
            name="loginId"
            type="text"
            autoComplete="username"
            autoCapitalize="characters"
            required
          />

          <label htmlFor="password">Password</label>
          <PasswordInput />

          <button type="submit">Sign in</button>
        </form>

        <p className="auth-links">
          <a href="/forgot-password">Forgot password?</a>
        </p>

        <p className="hint">
          Accounts without a recovery email on file should ask the school office
          for a new password.
        </p>
      </div>
    </main>
  );
}
