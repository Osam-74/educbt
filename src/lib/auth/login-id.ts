/**
 * Changing your own sign-in ID — the account-settings service.
 *
 * The sign-in ID is what a user types at the door, so changing it needs the
 * CURRENT PASSWORD: anyone who can borrow a signed-in browser must not be
 * able to swap the door's keyhole. Sessions read loginId LIVE from the users
 * row (session-store joins users on every request), so existing sessions
 * simply start reporting the new ID — nothing is cached in the session row.
 *
 * PLATFORM ADMIN ONLY today: school users' login IDs follow their staff
 * number / admission number (people/students.ts, people/staff.ts), and the
 * platform account is the only one whose ID is a free-form choice. This
 * service refuses school-tenant sessions rather than half-enforcing a rule
 * the staff/student flows already own.
 *
 * Uniqueness: users_school_login_uq is on (schoolId, loginId) — and a
 * platform admin's schoolId is NULL, which Postgres treats as DISTINCT in a
 * unique index, so the index does NOT stop two platform admins from sharing
 * an ID. The pre-check below is therefore the real guard for the platform
 * half (checked inside the same transaction, under the same platform_admin
 * elevation the write needs); the catch on 23505 stays as belt-and-braces
 * for the school-tenant day this service ever grows one.
 */

import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { verifyPassword } from '@/lib/auth/password';

export class LoginIdError extends Error {}

const LOGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]{2,190}$/;

/** Change the platform admin's own sign-in ID. Requires current password. */
export async function changeOwnLoginId(
  session: { id: number; schoolId: number | null; role: string; loginId: string },
  input: { newLoginId: string; currentPassword: string },
): Promise<void> {
  if (session.role !== 'platform_admin' || session.schoolId !== null) {
    throw new LoginIdError('Your sign-in ID is managed by your school office.');
  }
  if (!input.currentPassword) throw new LoginIdError('Enter your current password to confirm.');

  const newLoginId = input.newLoginId.trim();
  if (!newLoginId) throw new LoginIdError('Enter the new sign-in ID.');
  if (!LOGIN_ID_RE.test(newLoginId)) {
    throw new LoginIdError('Use letters, numbers, dots, hyphens or slashes (must start with a letter or number).');
  }
  if (newLoginId.toLowerCase() === session.loginId.toLowerCase()) {
    throw new LoginIdError('That is already your sign-in ID.');
  }

  await db.transaction(async (tx) => {
    // The audit row for a platform account has schoolId NULL — insertable
    // only while app.platform_admin is on for this transaction (same
    // elevation pattern as recovery-email.ts).
    await tx.execute(sql`select set_config('app.platform_admin', 'on', true)`);

    const [user] = await tx
      .select({
        id: schema.users.id,
        passwordHash: schema.users.passwordHash,
        loginId: schema.users.loginId,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.id))
      .limit(1);

    if (!user) throw new LoginIdError('Account not found.');

    const ok = await verifyPassword(user.passwordHash, input.currentPassword);
    if (!ok) throw new LoginIdError('Your current password was not recognised.');

    // Same-ID twin among platform admins? NULL schoolId defeats the unique
    // index, so this check IS the guard. Sign-in resolves by lower(loginId)
    // — two candidates would be an ambiguous door, which findUserForSignIn
    // refuses; better to refuse the rename up front.
    const [twin] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.role, 'platform_admin'),
          isNull(schema.users.schoolId),
          ne(schema.users.id, user.id),
          sql`lower(${schema.users.loginId}) = ${newLoginId.toLowerCase()}`,
        ),
      )
      .limit(1);
    if (twin) throw new LoginIdError('That sign-in ID is already in use.');

    try {
      await tx
        .update(schema.users)
        .set({ loginId: newLoginId })
        .where(eq(schema.users.id, user.id));

      await tx.insert(schema.auditLog).values({
        schoolId: null,
        actorUserId: user.id,
        actorRole: 'platform_admin',
        action: 'auth.login_id_changed',
        entityType: 'users',
        entityId: Number(user.id),
        before: { loginId: user.loginId },
        after: { loginId: newLoginId },
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new LoginIdError('That sign-in ID is already in use.');
      }
      throw error;
    }
  });
}
