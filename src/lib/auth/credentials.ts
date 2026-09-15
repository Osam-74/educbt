/**
 * Credential verification — the sign-in business rules.
 *
 * Free of next/* imports so the full matrix (good password, bad password,
 * lockout, suspended account, tenant scoping, staged 2FA) is regression-
 * testable from plain scripts (src/db/test-auth.ts). The glue in ./index.ts
 * owns the cookie; this module owns the decision.
 *
 * Rules that must never regress:
 *   - Throttle BEFORE touching the database: a flood of guesses costs an
 *     Upstash call, not a Postgres query and an Argon2 hash.
 *   - Every read and write is tenant-scoped (or covered by the narrow
 *     platform-admin policies in rls.sql). Under RLS an unscoped write
 *     silently no-ops, which would quietly disable the lockout.
 *   - A missing account burns the same Argon2 work as a wrong password:
 *     returning early would let an attacker enumerate admission numbers.
 *   - All failures that reveal nothing use the SAME message.
 *
 * Two-stage sign-in (Phase 7 UX fix):
 *   Stage 1 — login ID + password. If the account has two-factor on, this
 *   returns { secondFactorRequired: true } and NO session is created yet.
 *   Stage 2 — the six-digit code (or a one-time recovery code), verified by
 *   verifySecondFactor(), which only then lets the session finalise.
 *   The sign-in page therefore never shows a TOTP field to anyone before
 *   valid primary credentials are presented, and no browser can learn which
 *   accounts have two-factor.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, schema, forSchool } from '@/db';
import { verifyPassword } from '@/lib/auth/password';
import { verifyTotp } from '@/lib/auth/totp';
import { checkLoginThrottle, lockoutUntil } from '@/lib/auth/throttle';
import type { SessionUser } from '@/lib/auth/session-store';

export const GENERIC_FAILURE = 'Those sign-in details were not recognised.';

const credentialsSchema = z.object({
  loginId: z.string().min(1).max(191),
  password: z.string().min(1).max(200),
  schoolId: z.coerce.number().int().positive().nullable().optional(),
  ip: z.string().optional(),
});

// z.input, not z.infer: callers pass raw form strings and let the schema
// coerce — the *output* type is what parsed.data carries inside.
export type SignInInput = z.input<typeof credentialsSchema>;

export type CredentialResult = {
  user: SessionUser;
  /** True when stage 1 passed but the account has TOTP: ask for the code. */
  secondFactorRequired: boolean;
};

// The dummy hash exists so a missing account costs the same Argon2 work as a
// wrong password. The cost of verification is the point, not the result.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function sessionUserFrom(user: typeof schema.users.$inferSelect, staffId: number | null, studentId: number | null): SessionUser {
  return {
    id: user.id,
    schoolId: user.schoolId,
    role: user.role,
    loginId: user.loginId,
    mustChangePassword: user.mustChangePassword,
    staffId,
    studentId,
  };
}

/**
 * Look up a login account, case-insensitively.
 *
 * Login IDs are typed, dictated and photographed; 'SMOKE-PRIN-001' and
 * 'smoke-prin-001' are the same person. The stored value keeps its case; the
 * COMPARISON normalises. Pre-0017 data could hold both spellings as separate
 * rows (the unique index is case-sensitive), so more than one match is
 * treated as a hard failure — ambiguous is unauthenticated.
 */
async function findUserForSignIn(loginId: string, schoolId: number | null) {
  const needle = loginId.toLowerCase();
  // EMAIL LOGIN (correction-pass item 12): an address in the sign-in box
  // matches the account's recovery/login email too — the principal created
  // with a generated PRN-0001 ID types their email at the door. users_email_lc_uq
  // is global and lower-cased, so an email match is unambiguous; the
  // loginId match keeps working for staff/admission numbers. Anything that
  // is not obviously an address only ever tests loginId.
  const looksLikeEmail = needle.includes('@');
  const idOrEmail = looksLikeEmail
    ? sql`(lower(${schema.users.loginId}) = ${needle} or lower(${schema.users.email}) = ${needle})`
    : sql`lower(${schema.users.loginId}) = ${needle}`;

  if (schoolId) {
    return forSchool(schoolId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.users)
        .where(
          and(
            eq(schema.users.schoolId, schoolId),
            idOrEmail,
          ),
        )
        .limit(2);
      return rows;
    });
  }

  const rows = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.role, 'platform_admin'),
        isNull(schema.users.schoolId),
        idOrEmail,
      ),
    )
    .limit(2);
  return rows;
}

/**
 * Verify PRIMARY credentials (stage 1) and return the live user on success.
 * Two-factor accounts come back with secondFactorRequired — the caller must
 * run stage 2 before any session is finalised.
 * Throws Error with a user-safe message on any failure.
 */
export async function authenticateCredentials(raw: SignInInput): Promise<CredentialResult> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(GENERIC_FAILURE);

  const { loginId, password, schoolId, ip } = parsed.data;

  const throttle = await checkLoginThrottle(ip ?? 'unknown', schoolId ?? null, loginId);
  if (!throttle.allowed) {
    throw new Error(`Too many attempts. Try again in ${throttle.retryAfterSeconds ?? 60} seconds.`);
  }

  const candidates = await findUserForSignIn(loginId.trim(), schoolId ?? null);
  const user = candidates.length === 1 ? candidates[0] : undefined;

  if (!user) {
    await verifyPassword(DUMMY_HASH, password);
    throw new Error(GENERIC_FAILURE);
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const secs = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
    throw new Error(`This account is locked. Try again in ${secs} seconds.`);
  }

  if (user.status !== 'active') {
    // Says nothing about whether the password was right.
    throw new Error('This account is not active. Please contact the school office.');
  }

  const ok = await verifyPassword(user.passwordHash, password);

  if (!ok) {
    const attempts = user.failedAttempts + 1;

    // The lockout write is scoped exactly like the read. Under RLS an
    // unscoped UPDATE silently matches nothing — which would quietly disable
    // the lockout, the one defence that survives a Redis outage.
    await burnLockout(user, schoolId ?? null, attempts);
    throw new Error(GENERIC_FAILURE);
  }

  // Stage 1 passed. A two-factor account does NOT get a session yet — the
  // counters are deliberately NOT reset, so a wrong code on stage 2 burns
  // the same budget as a wrong password. Nobody can probe codes freely.
  if (user.totpEnabled) {
    return { user: sessionUserFrom(user, null, null), secondFactorRequired: true };
  }

  return { user: await finaliseSuccess(user, schoolId ?? null), secondFactorRequired: false };
}

/** Count a failed attempt into the lockout counters, tenant-scoped. */
async function burnLockout(
  user: typeof schema.users.$inferSelect,
  schoolId: number | null,
  attempts: number,
): Promise<void> {
  const patch = { failedAttempts: attempts, lockedUntil: lockoutUntil(attempts) };
  if (schoolId) {
    await forSchool(schoolId, async (tx) =>
      tx.update(schema.users).set(patch).where(eq(schema.users.id, user.id)));
  } else {
    await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
  }
}

/** Reset counters and resolve the staff/student identity, tenant-scoped. */
async function finaliseSuccess(
  user: typeof schema.users.$inferSelect,
  schoolId: number | null,
): Promise<SessionUser> {
  if (schoolId) {
    return forSchool(schoolId, async (tx) => {
      await tx
        .update(schema.users)
        .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(schema.users.id, user.id));

      const [staffRow] = await tx
        .select({ id: schema.staff.id })
        .from(schema.staff)
        .where(eq(schema.staff.userId, user.id))
        .limit(1);
      const [studentRow] = await tx
        .select({ id: schema.students.id })
        .from(schema.students)
        .where(eq(schema.students.userId, user.id))
        .limit(1);

      return sessionUserFrom(user, staffRow?.id ?? null, studentRow?.id ?? null);
    });
  }

  await db
    .update(schema.users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(schema.users.id, user.id));

  return sessionUserFrom(user, null, null);
}

// ── Stage 2: the two-step verification decision ───────────────────────────────

export type SecondFactorInput = {
  userId: number;
  schoolId: number | null;
  loginId: string;
  ip?: string;
};

const RECOVERY_CODE_HASH = (code: string) =>
  createHash('sha256').update(code.toLowerCase()).digest('hex');

/**
 * Verify the second factor of a staged sign-in.
 *
 * Accepts either the current six-digit TOTP code or an unused one-time
 * recovery code. A wrong code burns the SAME lockout budget as a wrong
 * password and shares the login throttle, so code-guessing is no cheaper
 * than password-guessing. A recovery code additionally forces a password
 * change: it is the "I lost my authenticator" door, and walking through it
 * must not leave the account on a password the user may not even remember
 * choosing.
 *
 * All reads and writes run in ONE transaction with both the session-user and
 * tenant GUCs set, so the users UPDATE passes the tenant policy and the
 * recovery-codes table (FORCED RLS) is reachable through the tenant or
 * session-user door.
 */
export async function verifySecondFactor(
  pending: SecondFactorInput,
  rawCode: string,
): Promise<{ user: SessionUser; recoveryCodeUsed: boolean }> {
  const code = rawCode.trim();

  const throttle = await checkLoginThrottle(
    pending.ip ?? 'unknown',
    pending.schoolId ?? null,
    pending.loginId,
  );
  if (!throttle.allowed) {
    throw new Error(`Too many attempts. Try again in ${throttle.retryAfterSeconds ?? 60} seconds.`);
  }

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.session_user_id', ${String(pending.userId)}, true)`,
    );
    if (pending.schoolId) {
      await tx.execute(
        sql`select set_config('app.school_id', ${String(pending.schoolId)}, true)`,
      );
    }

    const [user] = await tx
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, pending.userId))
      .limit(1);

    if (!user) throw new Error(GENERIC_FAILURE);

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const secs = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new Error(`This account is locked. Try again in ${secs} seconds.`);
    }
    if (user.status !== 'active') {
      throw new Error('This account is not active. Please contact the school office.');
    }

    let matched = false;
    let recoveryCodeId: number | null = null;

    if (/^\d{6}$/.test(code) && user.totpSecret) {
      matched = verifyTotp(user.totpSecret, code);
    }

    if (!matched && code.length >= 8) {
      const [rc] = await tx
        .select({ id: schema.totpRecoveryCodes.id })
        .from(schema.totpRecoveryCodes)
        .where(
          and(
            eq(schema.totpRecoveryCodes.userId, user.id),
            eq(schema.totpRecoveryCodes.codeHash, RECOVERY_CODE_HASH(code)),
            isNull(schema.totpRecoveryCodes.usedAt),
          ),
        )
        .limit(1);
      if (rc) {
        matched = true;
        recoveryCodeId = rc.id;
      }
    }

    if (!matched) {
      // The burn WRITES inside the transaction and the function must NOT
      // throw in here — a throw rolls the transaction back and eats the
      // burn (proven by test-totp). The message is thrown AFTER commit.
      const attempts = user.failedAttempts + 1;
      await tx
        .update(schema.users)
        .set({ failedAttempts: attempts, lockedUntil: lockoutUntil(attempts) })
        .where(eq(schema.users.id, user.id));
      return { ok: false as const, message: 'That code was not recognised. Check the app and try again.' };
    }

    if (recoveryCodeId) {
      await tx
        .update(schema.totpRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(schema.totpRecoveryCodes.id, recoveryCodeId));
    }

    const patch = recoveryCodeId
      ? {
          failedAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
          mustChangePassword: true,
        }
      : { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() };

    await tx.update(schema.users).set(patch).where(eq(schema.users.id, user.id));

    let staffId: number | null = null;
    let studentId: number | null = null;
    if (pending.schoolId) {
      const [staffRow] = await tx
        .select({ id: schema.staff.id })
        .from(schema.staff)
        .where(eq(schema.staff.userId, user.id))
        .limit(1);
      staffId = staffRow?.id ?? null;
      const [studentRow] = await tx
        .select({ id: schema.students.id })
        .from(schema.students)
        .where(eq(schema.students.userId, user.id))
        .limit(1);
      studentId = studentRow?.id ?? null;
    }

    return {
      ok: true as const,
      result: {
        user: sessionUserFrom(
          recoveryCodeId ? { ...user, mustChangePassword: true } : user,
          staffId,
          studentId,
        ),
        recoveryCodeUsed: recoveryCodeId !== null,
      },
    };
  });

  // Thrown AFTER the transaction committed, so the budget burn survives.
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}
