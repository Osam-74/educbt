/**
 * Credential verification — the sign-in business rules.
 *
 * Free of next/* imports so the full matrix (good password, bad password,
 * lockout, suspended account, tenant scoping) is regression-testable from
 * plain scripts (src/db/test-auth.ts). The glue in ./index.ts owns the
 * cookie; this module owns the decision.
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
 */

import { and, eq } from 'drizzle-orm';
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
  // Six digits from the authenticator when two-factor is on; absent otherwise.
  totpCode: z.string().trim().regex(/^\d{0,6}$/).optional(),
});

// z.input, not z.infer: callers pass raw form strings and let the schema
// coerce — the *output* type is what parsed.data carries inside.
export type SignInInput = z.input<typeof credentialsSchema>;

// The dummy hash exists so a missing account costs the same Argon2 work as a
// wrong password. The cost of verification is the point, not the result.
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * Verify credentials and return the live user on success.
 * Throws Error with a user-safe message on any failure.
 */
export async function authenticateCredentials(raw: SignInInput): Promise<SessionUser> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(GENERIC_FAILURE);

  const { loginId, password, schoolId, ip } = parsed.data;

  const throttle = await checkLoginThrottle(ip ?? 'unknown', schoolId ?? null, loginId);
  if (!throttle.allowed) {
    throw new Error(`Too many attempts. Try again in ${throttle.retryAfterSeconds ?? 60} seconds.`);
  }

  // School accounts are found INSIDE their tenant: RLS on users yields a row
  // only to its own school, so the lookup cannot drift across tenants even
  // if the WHERE clause were wrong. Platform-admin accounts own no school;
  // the narrow platform_admin_lookup policy (rls.sql) makes exactly those
  // rows findable before a tenant exists.
  let user: typeof schema.users.$inferSelect | undefined;
  if (schoolId) {
    user = await forSchool(schoolId, async (tx) => {
      const [u] = await tx
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.schoolId, schoolId), eq(schema.users.loginId, loginId)))
        .limit(1);
      return u;
    });
  } else {
    const rows = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.loginId, loginId), eq(schema.users.role, 'platform_admin')))
      .limit(1);
    user = rows[0];
  }

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
    const patch = { failedAttempts: attempts, lockedUntil: lockoutUntil(attempts) };
    if (schoolId) {
      await forSchool(schoolId, async (tx) =>
        tx.update(schema.users).set(patch).where(eq(schema.users.id, user.id)));
    } else {
      await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
    }

    throw new Error(GENERIC_FAILURE);
  }

  // Two-factor: the password alone is not enough for an account with TOTP
  // on. Checked AFTER the password so a wrong code burns exactly the same
  // lockout budget as a wrong password — a code-guesser cannot probe freely
  // — and BEFORE the success reset so a failed code still counts.
  if (user.totpEnabled) {
    const code = parsed.data.totpCode ?? '';

    if (code === '') {
      // Nothing to check yet: ask for the code without touching the counters.
      // The shared Upstash throttle still bounds retries per IP and login.
      throw new Error('Enter the code from your authenticator app.');
    }

    if (!verifyTotp(user.totpSecret ?? '', code)) {
      const attempts = user.failedAttempts + 1;
      const patch = { failedAttempts: attempts, lockedUntil: lockoutUntil(attempts) };
      if (schoolId) {
        await forSchool(schoolId, async (tx) =>
          tx.update(schema.users).set(patch).where(eq(schema.users.id, user.id)));
      } else {
        await db.update(schema.users).set(patch).where(eq(schema.users.id, user.id));
      }
      throw new Error('That code was not recognised.');
    }
  }

  // Success: reset the counters and resolve the staff/student identity this
  // account speaks for, in one tenant transaction. Authorisation is scoped
  // through these rows, not through the role name alone.
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

      return {
        id: user.id,
        schoolId: user.schoolId,
        role: user.role,
        loginId: user.loginId,
        mustChangePassword: user.mustChangePassword,
        staffId: staffRow?.id ?? null,
        studentId: studentRow?.id ?? null,
      };
    });
  }

  await db
    .update(schema.users)
    .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
    .where(eq(schema.users.id, user.id));

  return {
    id: user.id,
    schoolId: user.schoolId,
    role: user.role,
    loginId: user.loginId,
    mustChangePassword: user.mustChangePassword,
    staffId: null,
    studentId: null,
  };
}
