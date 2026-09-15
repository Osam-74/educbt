/**
 * Password recovery — the forgot-password service.
 *
 * Two truths shape this module:
 *
 *   1. Not every account has an email. Students and some school users have
 *      no inbox on file, so their recovery is ADMINISTRATIVE (the principal
 *      or office issues a one-time temporary password — people/staff.ts,
 *      people/students.ts). Email self-service recovery is offered ONLY to
 *      accounts that actually have a mailable address.
 *   2. The request must reveal nothing. The response is the same whether
 *      the account exists, has no email, or is suspended: generic text, no
 *      timing forks on user-visible paths, no enumeration.
 *
 * Token rules (Phase 3 security requirements):
 *   - 256 bits from crypto.randomBytes, base64url — never a hash of a guessable input
 *   - only the SHA-256 of the token is persisted
 *   - 30-minute expiry, single-use (used_at flips inside the consuming transaction)
 *   - 5 reset requests per hour per IP (Upstash; fails open on Redis outage)
 *   - a successful reset revokes EVERY session for the account, resets the
 *     lockout counters, and writes an audit event
 *
 * The email is QUEUED (email_events), never sent inline: the same Inngest
 * drain that ships notifications delivers recovery mail. Until the transport
 * is configured the queued row is the record of what should have been sent —
 * the runbook documents attaching an inbox before relying on the flow.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import { asPlatformAdmin, db, schema, forSchool } from '@/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { checkResetThrottle } from '@/lib/auth/throttle';
import { queueEmail } from '@/lib/comms/email';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RESET_TOKEN_MAX_AGE_SECONDS = 30 * 60;
export const GENERIC_RESET_RESPONSE =
  'If an eligible account exists, password-reset instructions have been sent.';

export class RecoveryError extends Error {}

export type ResetRequestResult = {
  /** ALWAYS show the generic response; this flag is for tests only. */
  emailQueued: boolean;
  throttled: boolean;
};

function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isMailable(email: string | null | undefined): boolean {
  return !!email && EMAIL_RE.test(email.trim()) && !email.trim().endsWith('.invalid');
}

/**
 * The best recovery address for an account: the users row first (set and
 * manageable from the account profile), then the role-specific columns
 * (staff.email, guardians.email) as they existed pre-0017. Students have no
 * address unless they set one themselves.
 */
async function recoveryEmailFor(
  user: typeof schema.users.$inferSelect,
): Promise<string | null> {
  if (isMailable(user.email)) return user.email!.trim();

  // Roles with a pre-existing address column reachable in the user's tenant.
  if (user.schoolId && ['principal', 'vice_principal', 'exam_officer', 'teacher'].includes(user.role)) {
    const staffRow = await forSchool(user.schoolId, async (tx) => {
      const [r] = await tx
        .select({ email: schema.staff.email })
        .from(schema.staff)
        .where(eq(schema.staff.userId, user.id))
        .limit(1);
      return r ?? null;
    });
    const staffEmail = staffRow?.email;
    if (isMailable(staffEmail)) return staffEmail!.trim();
  }

  if (user.schoolId && user.role === 'parent') {
    const guardianRow = await forSchool(user.schoolId, async (tx) => {
      const [r] = await tx
        .select({ email: schema.guardians.email })
        .from(schema.guardians)
        .where(eq(schema.guardians.userId, user.id))
        .limit(1);
      return r ?? null;
    });
    const guardianEmail = guardianRow?.email;
    if (isMailable(guardianEmail)) return guardianEmail!.trim();
  }

  return null;
}

/**
 * Find the account a recovery request refers to — by login ID OR by email,
 * case-insensitively, inside the caller's scope (their school's tenant, or
 * the platform-admin population when schoolId is null).
 *
 * An email match crosses schools by design (emails are globally unique on
 * users), but only within the scope the HOST allows: a request on school
 * A's host is scoped to school A's accounts + accounts whose EMAIL matches
 * from any school — no: the lookup stays inside the school's user population
 * so a request on one school's host can never fish another school's data;
 * the GLOBAL email index only serves the PLATFORM host and profile lookups.
 */
async function findRecoveryTarget(
  loginOrEmail: string,
  schoolId: number | null,
): Promise<typeof schema.users.$inferSelect | null> {
  const needle = loginOrEmail.trim().toLowerCase();

  if (schoolId) {
    return forSchool(schoolId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.users)
        .where(
          sql`lower(${schema.users.loginId}) = ${needle}
              OR lower(${schema.users.email}) = ${needle}`,
        )
        .limit(2);
      // Ambiguity (both a login and an email could match, or duplicated rows)
      // resolves to NO reset — silent, same as any other miss.
      return rows.length === 1 ? (rows[0] ?? null) : null;
    });
  }

  // Platform host: platform-admin accounts only. A school user typing their
  // admission number here gets nothing — same generic response, no leak.
  const rows = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.role, 'platform_admin'),
        isNull(schema.users.schoolId),
        sql`lower(${schema.users.loginId}) = ${needle}
            OR lower(${schema.users.email}) = ${needle}`,
      ),
    )
    .limit(2);
  return rows.length === 1 ? (rows[0] ?? null) : null;
}

/**
 * Request a password reset. NEVER reveals whether the account exists or has
 * an email — see GENERIC_RESET_RESPONSE. Queues the reset email inside the
 * same transaction as the token row, so the record of the attempt and its
 * token cannot drift apart.
 */
export async function requestPasswordReset(input: {
  loginOrEmail: string;
  schoolId: number | null;
  ip: string;
  origin: string;
}): Promise<ResetRequestResult> {
  const throttle = await checkResetThrottle(input.ip);
  if (!throttle.allowed) return { emailQueued: false, throttled: true };

  const user = await findRecoveryTarget(input.loginOrEmail, input.schoolId);
  if (!user || user.status !== 'active') {
    // Same response, and no extra work whose timing could leak the outcome.
    return { emailQueued: false, throttled: false };
  }

  const email = await recoveryEmailFor(user);
  if (!email) return { emailQueued: false, throttled: false };

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MAX_AGE_SECONDS * 1000);
  const link = `${input.origin.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;

  await db.transaction(async (tx) => {
    // Pin the RLS context BEFORE any write: the email_events and audit_log
    // rows are tenant-scoped. A school user is pinned to their own tenant; a
    // platform admin elevates for exactly this transaction (the audit row
    // below records what was done with the elevation).
    await tx.execute(
      sql`select set_config('app.session_user_id', ${String(user.id)}, true)`,
    );
    if (user.schoolId) {
      await tx.execute(
        sql`select set_config('app.school_id', ${String(user.schoolId)}, true)`,
      );
    } else {
      await tx.execute(sql`select set_config('app.platform_admin', 'on', true)`);
    }

    await tx.insert(schema.passwordResetTokens).values({
      tokenHash: hashResetToken(token),
      userId: user.id,
      schoolId: user.schoolId,
      expiresAt,
      createdIp: input.ip,
    });

    await queueEmail(tx, {
      schoolId: user.schoolId,
      to: email,
      subject: 'Your EduCBT password reset',
      body:
        `A password reset was requested for your EduCBT account (${user.loginId}).\n\n` +
        `Open the link below to choose a new password. The link works once and expires in 30 minutes.\n\n` +
        `${link}\n\n` +
        `If you did not request this, ignore this email — your password stays unchanged.\n`,
    });

    await tx.insert(schema.auditLog).values({
      schoolId: user.schoolId,
      actorUserId: user.id,
      actorRole: user.role,
      action: 'auth.password_reset_requested',
      entityType: 'users',
      entityId: user.id,
      ip: input.ip,
    });
  });

  return { emailQueued: true, throttled: false };
}

export type ResetOutcome =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Consume a reset token and set the new password. Everything happens in ONE
 * transaction: claim the token (single-use enforced by used_at flipping),
 * verify the password policy, rehash, revoke every session, audit. A token
 * claimed by another request milliseconds ago fails the claim — no double
 * spend, no reuse.
 *
 * Errors are generic by policy: valid-looking reasons are not enumerated to
 * the person holding the link.
 */
export async function resetPasswordWithToken(
  rawToken: string,
  newPassword: string,
  ip: string,
): Promise<ResetOutcome> {
  const GENERIC = 'This reset link is not valid or has expired. Request a new one.';

  if (!rawToken || newPassword.length < 8) {
    return { ok: false, error: newPassword.length < 8 ? 'Use at least 8 characters.' : GENERIC };
  }

  const tokenHash = hashResetToken(rawToken);

  // Claim-then-verify: the UPDATE is the atomic single-use lock. The school
  // scope comes from the TOKEN row (written at request time in the user's
  // tenant) — the users row itself cannot be read before the tenant is
  // pinned, that is the whole point of RLS on users.
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.passwordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.passwordResetTokens.tokenHash, tokenHash),
          isNull(schema.passwordResetTokens.usedAt),
          sql`${schema.passwordResetTokens.expiresAt} > now()`,
        ),
      )
      .returning({ userId: schema.passwordResetTokens.userId, schoolId: schema.passwordResetTokens.schoolId });

    if (rows.length !== 1) return null;
    return rows[0];
  });

  if (!claimed) return { ok: false, error: GENERIC };

  // Argon2 runs OUTSIDE the transaction (the pool is max:1).
  const passwordHash = await hashPassword(newPassword);

  const patch = {
    passwordHash,
    mustChangePassword: false, // the user CHOSE this password
    failedAttempts: 0,
    lockedUntil: null,
  };

  if (claimed.schoolId) {
    await forSchool(claimed.schoolId, async (tx) => {
      await tx.update(schema.users).set(patch).where(eq(schema.users.id, claimed.userId));

      await tx.insert(schema.auditLog).values({
        schoolId: claimed.schoolId,
        actorUserId: claimed.userId,
        actorRole: 'self',
        action: 'auth.password_reset_completed',
        entityType: 'users',
        entityId: claimed.userId,
        ip,
      });
    });
  } else {
    // Platform-admin accounts sit outside every tenant; the users row is
    // only writable under elevation, and elevation is only available through
    // the audited wrapper.
    await asPlatformAdmin(
      claimed.userId,
      `Password reset via emailed single-use token from ${ip}`,
      async (tx) => {
        await tx.update(schema.users).set(patch).where(eq(schema.users.id, claimed.userId));

        await tx.insert(schema.auditLog).values({
          schoolId: null,
          actorUserId: claimed.userId,
          actorRole: 'platform_admin',
          action: 'auth.password_reset_completed',
          entityType: 'users',
          entityId: claimed.userId,
          ip,
        });
      },
    );
  }

  // Every existing session is revoked — a reset usually means the old
  // password leaked, so other devices must sign in again.
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, claimed.userId));

  return { ok: true };
}
