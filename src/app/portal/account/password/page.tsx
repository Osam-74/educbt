import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { auth, signOut } from '@/lib/auth';
import { db, schema, forSchool, asPlatformAdmin } from '@/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';

export const dynamic = 'force-dynamic';

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const params = await searchParams;
  const session = await auth();

  if (!session) redirect('/sign-in');

  const forced = session.mustChangePassword;

  async function change(formData: FormData) {
    'use server';

    const inner = await auth();

    if (!inner) redirect('/sign-in');

    const current = String(formData.get('current') ?? '');
    const next = String(formData.get('next') ?? '');
    const confirm = String(formData.get('confirm') ?? '');

    const fail = (msg: string) =>
      redirect(`/portal/account/password?error=${encodeURIComponent(msg)}`);

    if (next !== confirm) fail('The new passwords do not match.');
    if (next.length < 8) fail('Use at least 8 characters.');
    if (next === current) fail('The new password must be different from the current one.');

    const userId = inner.id;
    const schoolId = inner.schoolId;

    // Every read and write here is tenant-scoped through the session's own
    // school. Under RLS an unscoped query returns nothing and an unscoped
    // UPDATE silently no-ops, so scoping is what makes this page work at all
    // — and the audit insert's RLS check requires the tenant to be set.
    // Platform-admin accounts own no school; their writes go through the
    // audited platform-admin path instead.
    let user: typeof schema.users.$inferSelect | undefined;
    if (schoolId) {
      user = await forSchool(schoolId, async (tx) => {
        const [u] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        return u;
      });
    } else {
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      user = rows[0];
    }

    if (!user) fail('Account not found.');

    // The current password is verified even on a FORCED change. Otherwise anyone
    // reaching an unattended, half-signed-in browser could take the account.
    const ok = await verifyPassword(user!.passwordHash, current);

    if (!ok) fail('Your current password is not correct.');

    // Argon2 runs OUTSIDE the transaction — hashing must never hold the
    // single pooled connection.
    const passwordHash = await hashPassword(next);

    if (schoolId) {
      await forSchool(schoolId, async (tx) => {
        await tx
          .update(schema.users)
          .set({ passwordHash, mustChangePassword: false })
          .where(eq(schema.users.id, userId));

        await tx.insert(schema.auditLog).values({
          schoolId: user!.schoolId,
          actorUserId: userId,
          actorRole: user!.role,
          action: 'auth.password_changed',
          entityType: 'users',
          entityId: userId,
        });
      });
    } else {
      await asPlatformAdmin(userId, 'Platform account password change', async (tx) => {
        await tx
          .update(schema.users)
          .set({ passwordHash, mustChangePassword: false })
          .where(eq(schema.users.id, userId));

        await tx.insert(schema.auditLog).values({
          schoolId: null,
          actorUserId: userId,
          actorRole: user!.role,
          action: 'auth.password_changed',
          entityType: 'users',
          entityId: userId,
        });
      });
    }

    // Every other session is ended. A password change usually means the old one
    // was shared or compromised, so leaving other devices signed in defeats it.
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));

    await signOut({ redirectTo: '/sign-in?error=Password+changed.+Please+sign+in+again.' });
  }

  return (
    <main className="auth-shell">
      <div className="auth-card">
        <h1>{forced ? 'Set your password' : 'Change your password'}</h1>
        <p className="sub">
          {forced
            ? 'Your school issued you a temporary password. Choose your own to continue.'
            : 'You will be signed out of all devices afterwards.'}
        </p>

        {params.error ? <p className="error">{params.error}</p> : null}

        <form action={change}>
          <label htmlFor="current">Current password</label>
          <input id="current" name="current" type="password" autoComplete="current-password" required />

          <label htmlFor="next">New password</label>
          <input id="next" name="next" type="password" autoComplete="new-password" minLength={8} required />

          <label htmlFor="confirm">Confirm new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />

          <button type="submit">Save password</button>
        </form>
      </div>
    </main>
  );
}
