/**
 * Platform-manager lifecycle services — the only code path through which
 * additional platform administrators are created, suspended and reactivated.
 *
 * WHY THIS EXISTS: the bootstrap script provisions the FIRST platform
 * administrator and deliberately refuses to run twice. Every manager after
 * that comes through here, with the same security model as the rest of
 * src/lib/platform/schools.ts:
 *
 *   1. Role check first — only platform_admin may call anything here.
 *   2. All work runs inside asPlatformAdmin() — the audited elevation that
 *      sets `app.platform_admin = 'on'` for exactly one transaction.
 *   3. Argon2 hashing runs BEFORE the transaction opens (the runtime pool
 *      is max:1 — never hold the one pooled connection through a hash).
 *   4. The temporary password is returned ONCE, shown once by the UI, and
 *      never stored, logged or written into any audit JSON.
 *
 * SIGN-IN MODEL: platform managers have school_id = NULL and no staff
 * record — they sign in with their login ID (or recovery email) at the
 * platform address, land in the forced password change on first sign-in
 * (must_change_password = true), and may then enrol TOTP like any platform
 * account. Uniqueness of login IDs among platform accounts is enforced by
 * the partial unique index users_platform_login_uq (migration 0019);
 * Postgres cannot do it via the (school_id, login_id) unique constraint
 * because NULL school_id rows never collide there.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { asPlatformAdmin, schema, type Tx } from '@/db';
import { hashPassword, generateInitialPassword } from '@/lib/auth/password';
import type { PlatformActor } from '@/lib/platform/session';

// ── Errors the UI can render as-is ───────────────────────────────────────────

export class ManagerPermissionError extends Error {
  constructor() {
    super('Only platform administrators may perform this action.');
  }
}

export class ManagerValidationError extends Error {
  fieldErrors: Record<string, string>;
  constructor(fieldErrors: Record<string, string>) {
    super('Please check the highlighted fields.');
    this.fieldErrors = fieldErrors;
  }
}

export class ManagerNotFoundError extends Error {
  constructor() {
    super('That manager could not be found.');
  }
}

export class ManagerConflictError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Platform sign-in IDs are what a manager actually types, so they stay
 * short, uppercase, and hyphen-friendly — the bootstrap account's
 * "PLATFORM-ADMIN" convention, not a school staff number.
 */
const managerLoginIdSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  // The form always submits a string; an EMPTY one means "generate the
  // next free ID", the same convention the recovery-email field uses.
  .transform((v) => (v === '' ? undefined : v))
  .refine((v) => v === undefined || v.length >= 3, 'Use at least 3 characters.')
  .refine((v) => v === undefined || v.length <= 64, 'That sign-in ID is too long.')
  .refine(
    (v) => v === undefined || /^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$|^[A-Z0-9]$/.test(v),
    'Use only letters, numbers and hyphens.',
  );

const managerSchema = z.object({
  loginId: managerLoginIdSchema.optional(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .optional()
    .transform((v) => (v === '' ? undefined : v))
    .refine((v) => v === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Enter a valid email address.'),
});

export type ManagerInput = z.infer<typeof managerSchema>;
type ValidatedManager = { loginId?: string; email?: string };

export type PlatformManagerSummary = {
  id: number;
  loginId: string;
  email: string | null;
  status: 'active' | 'suspended';
  totpEnabled: boolean;
  createdAt: Date;
  lastLoginAt: Date | null;
};

function assertPlatformAdmin(actor: PlatformActor): void {
  if (actor.role !== 'platform_admin') throw new ManagerPermissionError();
}

/**
 * Postgres 23505 (unique violation) → friendly message, at this boundary —
 * same convention as schools.ts: match on the driver error's code and
 * message (postgres.js puts the constraint name there), not its detail.
 */
function mapDuplicate(error: unknown, loginId: string): never {
  const e = error as { code?: string; message?: string };
  if (e?.code !== '23505') throw error instanceof Error ? error : new Error(String(error));

  const msg = e.message ?? '';
  if (msg.includes('users_platform_login_uq')) {
    throw new ManagerConflictError(`The sign-in ID "${loginId}" is already used by a platform account.`);
  }
  if (msg.includes('users_email_lc_uq')) {
    throw new ManagerConflictError('That email address already belongs to another account.');
  }
  throw new ManagerConflictError('A required detail is already in use. Please review and try again.');
}

// ── Reading the directory ─────────────────────────────────────────────────────

export async function listPlatformManagers(
  actor: PlatformActor,
  readReason = 'View platform manager directory',
): Promise<PlatformManagerSummary[]> {
  assertPlatformAdmin(actor);

  return asPlatformAdmin(actor.userId, readReason, async (tx) => {
    const rows = await tx
      .select({
        id: schema.users.id,
        loginId: schema.users.loginId,
        email: schema.users.email,
        status: schema.users.status,
        totpEnabled: schema.users.totpEnabled,
        createdAt: schema.users.createdAt,
        lastLoginAt: schema.users.lastLoginAt,
      })
      .from(schema.users)
      .where(and(isNull(schema.users.schoolId), eq(schema.users.role, 'platform_admin')))
      .orderBy(asc(schema.users.id));

    return rows.map((r) => ({
      id: Number(r.id),
      loginId: r.loginId,
      email: r.email,
      status: r.status === 'suspended' ? 'suspended' : 'active',
      totpEnabled: r.totpEnabled,
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
    }));
  });
}

// ── Creating a manager ────────────────────────────────────────────────────────

/**
 * The next free PLATFORM-ADMIN sign-in ID inside this transaction, when the
 * admin did not choose one. PLATFORM-ADMIN itself is the bootstrap account
 * (and may be taken by it), so generated IDs continue from -2.
 */
async function nextFreeManagerLoginId(tx: Tx, fallbackSeed: number): Promise<string> {
  const existing = await tx
    .select({ loginId: schema.users.loginId })
    .from(schema.users)
    .where(and(isNull(schema.users.schoolId), eq(schema.users.role, 'platform_admin')));

  const taken = new Set(existing.map((r) => r.loginId));
  let n = fallbackSeed;
  while (taken.has(`PLATFORM-ADMIN-${n}`)) n += 1;
  return `PLATFORM-ADMIN-${n}`;
}

export async function createPlatformManager(
  actor: PlatformActor,
  rawInput: ManagerInput,
): Promise<{ loginId: string; temporaryPassword: string }> {
  assertPlatformAdmin(actor);
  const parsed = managerSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ManagerValidationError(
      Object.fromEntries(parsed.error.issues.map((issue) => [issue.path[0] ?? 'form', issue.message])),
    );
  }
  const input: ValidatedManager = parsed.data;

  const temporaryPassword = generateInitialPassword(12);
  const passwordHash = await hashPassword(temporaryPassword);

  const reason = 'Create a platform manager account';

  try {
    return await asPlatformAdmin(actor.userId, reason, async (tx) => {
      const loginId = input.loginId ?? (await nextFreeManagerLoginId(tx, 2));

      const [created] = await tx
        .insert(schema.users)
        .values({
          schoolId: null,
          role: 'platform_admin',
          loginId,
          passwordHash,
          // Optional recovery address, unverified until the manager confirms.
          email: input.email ?? null,
          // The temporary password must be replaced at first sign-in.
          mustChangePassword: true,
          status: 'active',
        })
        .returning({ id: schema.users.id, loginId: schema.users.loginId });

      await tx.insert(schema.auditLog).values({
        schoolId: null,
        actorUserId: actor.userId,
        actorRole: 'platform_admin',
        action: 'platform_admin.manager_created',
        entityType: 'users',
        entityId: Number(created!.id),
        before: null,
        after: { loginId, email: input.email ?? null, temporaryPasswordIssued: true },
      });

      return { loginId: created!.loginId, temporaryPassword };
    });
  } catch (error) {
    mapDuplicate(error, input.loginId ?? 'the generated sign-in ID');
  }
}

// ── Suspending / reactivating ─────────────────────────────────────────────────

/**
 * Guardrails: a manager cannot suspend their own account, and the LAST
 * active platform manager cannot be suspended — either would lock the
 * platform out of its own administration. Both are checked inside the
 * elevation transaction, against live data.
 */
export async function setManagerStatus(
  actor: PlatformActor,
  managerId: number,
  status: 'active' | 'suspended',
): Promise<void> {
  assertPlatformAdmin(actor);

  const reason =
    status === 'suspended'
      ? `Suspend platform manager account #${managerId}`
      : `Reactivate platform manager account #${managerId}`;

  await asPlatformAdmin(actor.userId, reason, async (tx) => {
    const [target] = await tx
      .select({ id: schema.users.id, status: schema.users.status, role: schema.users.role })
      .from(schema.users)
      .where(and(eq(schema.users.id, managerId), isNull(schema.users.schoolId)))
      .limit(1);

    if (!target || target.role !== 'platform_admin') throw new ManagerNotFoundError();
    if (target.status === status) return; // idempotent no-op, no audit noise

    if (status === 'suspended') {
      if (Number(target.id) === actor.userId) {
        throw new ManagerConflictError('You cannot suspend your own account.');
      }
      const activeManagers = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            isNull(schema.users.schoolId),
            eq(schema.users.role, 'platform_admin'),
            eq(schema.users.status, 'active'),
          ),
        );
      if (activeManagers.length <= 1) {
        throw new ManagerConflictError('At least one active platform manager must remain.');
      }
    }

    await tx
      .update(schema.users)
      .set({ status })
      .where(eq(schema.users.id, managerId));

    await tx.insert(schema.auditLog).values({
      schoolId: null,
      actorUserId: actor.userId,
      actorRole: 'platform_admin',
      action: status === 'suspended' ? 'platform_admin.manager_suspended' : 'platform_admin.manager_reactivated',
      entityType: 'users',
      entityId: managerId,
      before: { status: target.status },
      after: { status },
    });
  });
}

// ── Resetting a manager's password ────────────────────────────────────────────

export type ManagerPasswordReset = { loginId: string; temporaryPassword: string };

/**
 * Issues a fresh temporary password exactly like resetStaffPassword() does
 * for school staff: hashed before the transaction opens, forces a change at
 * next sign-in, and revokes every existing session so the old password
 * stops working immediately. A manager resets their OWN password from
 * Account Settings, not here — self-service is refused so this screen
 * cannot be used to silently take over the caller's own account.
 */
export async function resetManagerPassword(
  actor: PlatformActor,
  managerId: number,
): Promise<ManagerPasswordReset> {
  assertPlatformAdmin(actor);

  if (managerId === actor.userId) {
    throw new ManagerConflictError('Change your own password from Account Settings, not here.');
  }

  const temporaryPassword = generateInitialPassword(12);
  const passwordHash = await hashPassword(temporaryPassword);

  return asPlatformAdmin(actor.userId, `Reset password for platform manager account #${managerId}`, async (tx) => {
    const [target] = await tx
      .select({ id: schema.users.id, loginId: schema.users.loginId, role: schema.users.role })
      .from(schema.users)
      .where(and(eq(schema.users.id, managerId), isNull(schema.users.schoolId)))
      .limit(1);

    if (!target || target.role !== 'platform_admin') throw new ManagerNotFoundError();

    await tx.update(schema.users).set({
      passwordHash,
      mustChangePassword: true,
      failedAttempts: 0,
      lockedUntil: null,
    }).where(eq(schema.users.id, managerId));

    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, managerId));

    await tx.insert(schema.auditLog).values({
      schoolId: null,
      actorUserId: actor.userId,
      actorRole: 'platform_admin',
      action: 'platform_admin.manager_password_reset',
      entityType: 'users',
      entityId: managerId,
      after: { temporaryPasswordIssued: true, sessionsRevoked: true },
    });

    return { loginId: target.loginId, temporaryPassword };
  });
}

// ── Deleting a manager ─────────────────────────────────────────────────────────

/**
 * Permanent removal — distinct from suspend/reactivate, which keeps the
 * account around to bring back. Same self-protection and "someone must be
 * left standing" guardrails as setManagerStatus(): you cannot delete your
 * own account, and the platform can never be left with zero manager
 * accounts (active or suspended) — that would be a platform no one can
 * ever sign into again. Audit log keeps a before-snapshot since the row
 * itself is gone after this.
 */
export async function deletePlatformManager(actor: PlatformActor, managerId: number): Promise<void> {
  assertPlatformAdmin(actor);

  if (managerId === actor.userId) {
    throw new ManagerConflictError('You cannot delete your own account.');
  }

  await asPlatformAdmin(actor.userId, `Delete platform manager account #${managerId}`, async (tx) => {
    const [target] = await tx
      .select({ id: schema.users.id, loginId: schema.users.loginId, status: schema.users.status, role: schema.users.role })
      .from(schema.users)
      .where(and(eq(schema.users.id, managerId), isNull(schema.users.schoolId)))
      .limit(1);

    if (!target || target.role !== 'platform_admin') throw new ManagerNotFoundError();

    const allManagers = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(isNull(schema.users.schoolId), eq(schema.users.role, 'platform_admin')));

    if (allManagers.length <= 1) {
      throw new ManagerConflictError('At least one platform manager account must remain.');
    }

    await tx.delete(schema.users).where(eq(schema.users.id, managerId));

    await tx.insert(schema.auditLog).values({
      schoolId: null,
      actorUserId: actor.userId,
      actorRole: 'platform_admin',
      action: 'platform_admin.manager_deleted',
      entityType: 'users',
      entityId: managerId,
      before: { loginId: target.loginId, status: target.status },
    });
  });
}
