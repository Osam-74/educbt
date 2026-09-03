import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { tenantFromHost } from '@/lib/tenant';
import { auth, signIn } from '@/lib/auth';

// Never cached: the page is per-hostname and reflects session state.
export const dynamic = 'force-dynamic';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (session) redirect('/portal');

  const host = (await headers()).get('host');
  const school = await tenantFromHost(host);

  // The hostname identifies the school. If it resolves to nothing, there is no
  // school to sign in to — and we say so plainly rather than presenting a form
  // that cannot succeed.
  if (!school) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>School not found</h1>
          <p className="sub">
            This address is not linked to a school. Check the link your school gave you.
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
