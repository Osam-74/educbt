/**
 * Managing two-factor authentication on your own account — the same shape as
 * change-password.ts: one service for every role, tenant-scoped writes.
 *
 * The three-step flow keeps a half-finished enrollment harmless:
 *   start    — a fresh secret is STORED but stays disabled. Nothing about the
 *              account's sign-in changes until a code from the authenticator
 *              proves the app was provisioned correctly.
 *   confirm  — the user's first valid code flips totp_enabled. A secret that
 *              was never confirmed is indistinguishable from no enrollment.
 *   disable  — requires a VALID CURRENT code, not just a signed-in session:
 *              an attacker with a borrowed browser must still hold the
 *              authenticator to turn the gate off. A lost authenticator is
 *              an office reset, the same way a forgotten password is.
 */

import { eq } from 'drizzle-orm';
import { db, schema, forSchool } from '@/db';
import { generateTotpSecret, otpauthUri, verifyTotp } from '@/lib/auth/totp';
import { clearRecoveryCodes, issueRecoveryCodes, remainingRecoveryCodes } from '@/lib/auth/recovery-codes';

export class TotpError extends Error {}

async function readUser(session: { id: number; schoolId: number | null }) {
  if (session.schoolId) {
    return forSchool(session.schoolId, async (tx) => {
      const [u] = await tx
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, session.id))
        .limit(1);
      return u;
    });
  }
  const rows = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, session.id))
    .limit(1);
  return rows[0];
}

/** Is two-factor on for this account? (For rendering; never returns the secret.) */
export async function totpStatus(session: { id: number; schoolId: number | null }): Promise<{ enabled: boolean }> {
  const user = await readUser(session);
  if (!user) throw new TotpError('Account not found.');
  return { enabled: user.totpEnabled };
}

/**
 * Generate and store a pending secret. Returns what the user types or scans
 * into their authenticator. Safe to call repeatedly — an old unconfirmed
 * secret is simply replaced, and none of them affect sign-in while disabled.
 */
export async function startTotpEnrollment(
  session: { id: number; schoolId: number | null },
): Promise<{ secret: string; uri: string }> {
  const user = await readUser(session);
  if (!user) throw new TotpError('Account not found.');
  if (user.totpEnabled) throw new TotpError('Two-factor is already on for this account.');

  const secret = generateTotpSecret();
  const patch = { totpSecret: secret, totpEnabled: false };

  if (session.schoolId) {
    await forSchool(session.schoolId, async (tx) =>
      tx.update(schema.users).set(patch).where(eq(schema.users.id, session.id)));
  } else {
    await db.update(schema.users).set(patch).where(eq(schema.users.id, session.id));
  }

  // The issuer is the account's school when it has one, the platform otherwise.
  const issuer = session.schoolId ? 'EduCBT' : 'EduCBT Platform';
  return { secret, uri: otpauthUri(secret, user.loginId, issuer) };
}

/** Read the PENDING secret for the enrollment screen after a page re-render. */
export async function pendingEnrollment(
  session: { id: number; schoolId: number | null },
): Promise<{ secret: string; uri: string } | null> {
  const user = await readUser(session);
  if (!user || user.totpEnabled || !user.totpSecret) return null;
  const issuer = session.schoolId ? 'EduCBT' : 'EduCBT Platform';
  return { secret: user.totpSecret, uri: otpauthUri(user.totpSecret, user.loginId, issuer) };
}

/** Confirm the authenticator was provisioned: flip two-factor on and issue
 *  the one-time recovery codes. The codes come back exactly once — the page
 *  that calls this is the only thing that ever sees them in plaintext. */
export async function confirmTotpEnrollment(
  session: { id: number; schoolId: number | null },
  code: string,
): Promise<{ recoveryCodes: string[] }> {
  const user = await readUser(session);
  if (!user) throw new TotpError('Account not found.');
  if (user.totpEnabled) throw new TotpError('Two-factor is already on for this account.');
  if (!user.totpSecret) throw new TotpError('Start the setup first.');

  if (!verifyTotp(user.totpSecret, code)) {
    throw new TotpError('That code was not recognised. Check the app and try again.');
  }

  const patch = { totpEnabled: true };
  if (session.schoolId) {
    await forSchool(session.schoolId, async (tx) =>
      tx.update(schema.users).set(patch).where(eq(schema.users.id, session.id)));
  } else {
    await db.update(schema.users).set(patch).where(eq(schema.users.id, session.id));
  }

  const recoveryCodes = await issueRecoveryCodes(session);
  return { recoveryCodes };
}

/** Turn two-factor off. Requires a valid current code — see the header. */
export async function disableTotp(
  session: { id: number; schoolId: number | null },
  code: string,
): Promise<void> {
  const user = await readUser(session);
  if (!user) throw new TotpError('Account not found.');
  if (!user.totpEnabled || !user.totpSecret) {
    throw new TotpError('Two-factor is not on for this account.');
  }

  if (!verifyTotp(user.totpSecret, code)) {
    throw new TotpError('That code was not recognised.');
  }

  const patch = { totpEnabled: false, totpSecret: null };
  if (session.schoolId) {
    await forSchool(session.schoolId, async (tx) =>
      tx.update(schema.users).set(patch).where(eq(schema.users.id, session.id)));
  } else {
    await db.update(schema.users).set(patch).where(eq(schema.users.id, session.id));
  }

  // Two-factor off means the codes that exist to back it up are dead weight.
  await clearRecoveryCodes(session);
}

/** How many one-time recovery codes remain unused. For the security screen. */
export async function recoveryCodesRemaining(
  session: { id: number; schoolId: number | null },
): Promise<number> {
  return remainingRecoveryCodes(session);
}

/** Regenerate the recovery codes after re-authentication. Plaintext once. */
export async function regenerateRecoveryCodes(
  session: { id: number; schoolId: number | null },
  code: string,
): Promise<string[]> {
  const user = await readUser(session);
  if (!user) throw new TotpError('Account not found.');
  if (!user.totpEnabled || !user.totpSecret) {
    throw new TotpError('Two-factor is not on for this account.');
  }
  if (!verifyTotp(user.totpSecret, code)) {
    throw new TotpError('That code was not recognised.');
  }
  return issueRecoveryCodes(session);
}
