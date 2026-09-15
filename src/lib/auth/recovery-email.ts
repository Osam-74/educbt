/**
 * Managing your own recovery email — the account-profile service.
 *
 * The recovery email is OPTIONAL (students usually have none) and is where
 * password-reset links go (recovery.ts). Setting or changing it requires the
 * CURRENT PASSWORD: the address controls account recovery, so it must not be
 * settable by a borrowed browser.
 *
 * A changed address is UNVERIFIED (email_verified_at reset to null) until the
 * owner confirms it — console-attached addresses are marked verified by the
 * one-time owner script (scripts/attach-platform-admin-email.ts), the only
 * path that can short-cut verification.
 *
 * Uniqueness is enforced by the database (users_email_lc_uq, global on
 * lower(email)) rather than a pre-read: one account's email is not readable
 * from another's tenant under RLS, and TOCTOU pre-checks are not guarantees.
 */

import { eq, sql } from 'drizzle-orm';
import { db, schema, forSchool } from '@/db';
import { verifyPassword } from '@/lib/auth/password';

export class RecoveryEmailError extends Error {}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Read the account's display fields for the profile page. */
export async function profileView(
  session: { id: number; schoolId: number | null; role: string; loginId: string },
): Promise<{
  displayName: string;
  email: string | null;
  emailVerified: boolean;
}> {
  const read = async (tx: Parameters<Parameters<typeof forSchool>[1]>[0]) => {
    const [user] = await tx
      .select({
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.id))
      .limit(1);

    let displayName = session.loginId;
    if (session.schoolId) {
      const [staff] = await tx
        .select({ firstName: schema.staff.firstName, lastName: schema.staff.lastName })
        .from(schema.staff)
        .where(eq(schema.staff.userId, session.id))
        .limit(1);
      if (staff) {
        displayName = `${staff.firstName} ${staff.lastName}`.trim() || displayName;
      } else {
        const [student] = await tx
          .select({
            firstName: schema.students.firstName,
            lastName: schema.students.lastName,
          })
          .from(schema.students)
          .where(eq(schema.students.userId, session.id))
          .limit(1);
        if (student) {
          displayName = `${student.firstName} ${student.lastName}`.trim() || displayName;
        } else {
          const [guardian] = await tx
            .select({ fullName: schema.guardians.fullName })
            .from(schema.guardians)
            .where(eq(schema.guardians.userId, session.id))
            .limit(1);
          if (guardian?.fullName) displayName = guardian.fullName;
        }
      }
    }

    return {
      displayName,
      email: user?.email ?? null,
      emailVerified: Boolean(user?.emailVerifiedAt),
    };
  };

  if (session.schoolId) return forSchool(session.schoolId, read);
  return db.transaction(async (tx) => read(tx));
}

/**
 * Set, change or clear the recovery email. Requires the current password.
 * An empty string clears the address (no reset emails possible until a new
 * one is set). Every change is audited with the OLD value so an account
 * takeover is reconstructable from the trail.
 */
export async function setRecoveryEmail(
  session: { id: number; schoolId: number | null; loginId: string; role: string },
  input: { email: string; currentPassword: string },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const currentPassword = input.currentPassword;

  if (!currentPassword) throw new RecoveryEmailError('Enter your current password to confirm.');
  if (email && !EMAIL_RE.test(email)) throw new RecoveryEmailError('That email address is not valid.');
  if (email.length > 320) throw new RecoveryEmailError('That email address is too long.');

  const write = async (tx: Parameters<Parameters<typeof forSchool>[1]>[0]) => {
    const [user] = await tx
      .select({
        id: schema.users.id,
        passwordHash: schema.users.passwordHash,
        email: schema.users.email,
        schoolId: schema.users.schoolId,
        role: schema.users.role,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.id))
      .limit(1);

    if (!user) throw new RecoveryEmailError('Account not found.');

    const ok = await verifyPassword(user.passwordHash, currentPassword);
    if (!ok) throw new RecoveryEmailError('Your current password was not recognised.');

    try {
      await tx
        .update(schema.users)
        .set({ email: email || null, emailVerifiedAt: null })
        .where(eq(schema.users.id, user.id));

      await tx.insert(schema.auditLog).values({
        schoolId: user.schoolId,
        actorUserId: user.id,
        actorRole: user.role,
        action: 'auth.recovery_email_changed',
        entityType: 'users',
        entityId: Number(user.id),
        before: { email: user.email },
        after: { email: email || null },
      });
    } catch (error) {
      // users_email_lc_uq: the address already belongs to another account.
      // Which account is not our business to reveal.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new RecoveryEmailError('That email address is already in use on another account.');
      }
      throw error;
    }
  };

  if (session.schoolId) {
    await forSchool(session.schoolId, write);
  } else {
    // Platform admin: schoolId is null (schema guarantee — only the platform
    // account belongs to no school), so the audit row below is written with
    // schoolId: null. Under RLS that row is only insertable while
    // app.platform_admin = 'on' for THIS transaction — the same elevation
    // asPlatformAdmin() uses (db/index.ts). Without it the audit INSERT's
    // WITH CHECK fails (school_id = current_school_id() is null = null →
    // NULL, is_platform_admin() is false) and the whole save 42501s, which
    // is exactly the bug this guards against. The role check is defense in
    // depth against a caller ever reaching this branch without actually
    // being the platform admin.
    if (session.role !== 'platform_admin') {
      throw new RecoveryEmailError('Account not found.');
    }
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.platform_admin', 'on', true)`);
      return write(tx);
    });
  }
}
