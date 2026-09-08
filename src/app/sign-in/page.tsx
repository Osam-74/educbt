import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { tenantFromHost } from '@/lib/tenant';
import { auth, signIn } from '@/lib/auth';

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

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (session) redirect(homeFor(session.role));

  const host = (await headers()).get('host');
  const school = await tenantFromHost(host);

  // The hostname identifies the school. If it resolves to nothing, there is no
  // school to sign in to — so this is the PLATFORM host, and the only account
  // that can sign in here is a platform administrator (whose account owns no
  // school; see the platform_admin_lookup policy).
  if (!school) {
    async function platformSignIn(formData: FormData) {
      'use server';

      try {
        await signIn({
          loginId: String(formData.get('loginId') ?? '').trim(),
          password: String(formData.get('password') ?? ''),
          // null: the platform-admin sign-in path. The credential decision in
          // credentials.ts resolves ONLY platform-admin accounts with this.
          schoolId: null,
        });
      } catch (error) {
        if (error instanceof Error && error.message) {
          redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
        }
        throw error;
      }

      redirect('/platform');
    }

    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>EduCBT Platform</h1>
          <p className="sub">Platform administration sign-in</p>

          {params.error ? <p className="error">{params.error}</p> : null}

          <form action={platformSignIn}>
            <label htmlFor="loginId">Platform sign-in ID</label>
            <input
              id="loginId"
              name="loginId"
              type="text"
              autoComplete="username"
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />

            <button type="submit">Sign in</button>
          </form>

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

    try {
      await signIn({
        loginId: String(formData.get('loginId') ?? '').trim(),
        password: String(formData.get('password') ?? ''),
        // The tenant comes from the HOSTNAME resolution in this closure —
        // never from the posted form, which a user could edit.
        schoolId: school.id,
      });
    } catch (error) {
      // All expected failures throw a user-safe message (credentials.ts);
      // redirect surfaces it on the form. Anything else is a bug: rethrow.
      if (error instanceof Error && error.message) {
        redirect(`/sign-in?error=${encodeURIComponent(error.message)}`);
      }

      throw error;
    }

    redirect(target.startsWith('/') ? target : '/portal');
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{school.name}</h1>
        <p className="sub">Sign in to continue</p>

        {params.error ? <p className="error">{params.error}</p> : null}

        <form action={authenticate}>
          {/* The tenant is never posted: the server action takes the school
              from the hostname resolution in its closure, so editing anything
              in this form cannot change which school's account is used. */}
          <input type="hidden" name="next" value={params.next ?? '/portal'} />

          <label htmlFor="loginId">Admission or staff number</label>
          <input
            id="loginId"
            name="loginId"
            type="text"
            autoComplete="username"
            autoCapitalize="characters"
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />

          <button type="submit">Sign in</button>
        </form>

        <p className="hint">
          Forgotten your password? The school office will issue a new one — there is no
          self-service reset, because most students have no email address on file.
        </p>
      </div>
    </main>
  );
}
