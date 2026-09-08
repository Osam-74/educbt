/**
 * Changing your own password — one service for every role, portal or platform.
 *
 * The rules live here once, not once per page:
 *   - the CURRENT password is verified even on a forced change, so an
 *     unattended half-signed-in browser cannot take the account;
 *   - Argon2 runs OUTSIDE the transaction (the runtime pool is max:1);
 *   - school accounts write through their tenant scope, platform accounts
 *     through the audited platform-admin path;
 *   - every session is destroyed afterwards: a password change usually means
 *     the old one leaked, so other devices must sign in again.
 */

import { eq } from 'drizzle-orm';
import { db, schema, forSchool, asPlatformAdmin } from '@/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';

export class PasswordChangeError extends Error {}

export async function changeOwnPassword(
  session: { id: number; schoolId: number | null },
  current: string,
  next: string,
): Promise<void> {
  if (next.length < 8) {
    throw new PasswordChangeError('Use at least 8 characters.');
  }
  if (next === current) {
    throw new PasswordChangeError('The new password must be different from the current one.');
  }

  const userId = session.id;
  const schoolId = session.schoolId;

  // Every read here is scope-checked the same way sign-in is: tenant scope for
  // school accounts, the platform-admin policies for platform accounts.
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

  if (!user) throw new PasswordChangeError('Account not found.');

  const ok = await verifyPassword(user.passwordHash, current);
  if (!ok) throw new PasswordChangeError('Your current password is not correct.');

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
        schoolId,
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
}
