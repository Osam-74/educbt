/**
 * Guardian invite redemption.
 *
 * The office issues a one-time invite token when linking a guardian
 * (see linkGuardian in students.ts). The token is shown to the office once and
 * handed to the parent out of band. This is the other half of the flow: the
 * parent redeems it to create their OWN account — the school never sets or
 * sees the parent's password.
 *
 * The token is the capability, exactly like a passport photo token: the accept
 * page is public, unauthenticated, and resolves the school from the hostname
 * alone. Everything else is scoped by forSchool / RLS.
 */

import { and, eq } from 'drizzle-orm';
import { schema, forSchool } from '@/db';
import { hashPassword } from '@/lib/auth/password';

export class GuardianAcceptError extends Error {}

export type GuardianAcceptResult = { loginId: string; fullName: string };

export async function acceptGuardianInvite(
  schoolId: number,
  token: string,
  password: string,
): Promise<GuardianAcceptResult> {
  if (!Number.isInteger(schoolId) || schoolId <= 0) {
    throw new GuardianAcceptError('This invitation link is not valid.');
  }
  token = token.trim();
  if (!token) throw new GuardianAcceptError('This invitation link is not valid.');
  if (password.length < 8) {
    throw new GuardianAcceptError('Use at least 8 characters for your password.');
  }

  // Argon2 runs OUTSIDE the transaction: the runtime pool is max:1 and a slow
  // hash inside forSchool would pin the one warm connection (see change-password.ts).
  const passwordHash = await hashPassword(password);

  return forSchool(schoolId, async (tx) => {
    const [guardian] = await tx
      .select({
        id: schema.guardians.id,
        fullName: schema.guardians.fullName,
        email: schema.guardians.email,
        inviteStatus: schema.guardians.inviteStatus,
        userId: schema.guardians.userId,
      })
      .from(schema.guardians)
      .where(eq(schema.guardians.inviteToken, token))
      .limit(1);

    // One message for "never issued", "already used" and "wrong school" — the
    // token is cleared on accept, so a reused link simply stops resolving.
    if (!guardian || guardian.inviteStatus === 'accepted' || guardian.userId) {
      throw new GuardianAcceptError('This invitation link is not valid. Ask the school office for a new invitation.');
    }
    if (!guardian.email) {
      throw new GuardianAcceptError('This invitation has no email address. Please contact the school office.');
    }

    const loginId = guardian.email.toLowerCase();

    // An account for this email already exists: NEVER claim it here. Letting a
    // token holder reset an existing parent's password would turn a forwarded
    // email into an account takeover. The parent signs in with their own
    // password; the office can relink from the staff side.
    const [existing] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.loginId, loginId), eq(schema.users.role, 'parent')))
      .limit(1);
    if (existing) {
      throw new GuardianAcceptError('An account already exists for this email. Sign in with your existing password.');
    }

    const [user] = await tx
      .insert(schema.users)
      .values({
        schoolId,
        role: 'parent',
        loginId,
        passwordHash,
        // The parent chose this password themselves — no forced change cycle.
        mustChangePassword: false,
        status: 'active',
      })
      .returning({ id: schema.users.id });

    await tx
      .update(schema.guardians)
      .set({ userId: user!.id, inviteStatus: 'accepted', inviteToken: null })
      .where(eq(schema.guardians.id, guardian.id));

    await tx.insert(schema.auditLog).values({
      schoolId,
      actorUserId: user!.id,
      actorRole: 'parent',
      action: 'guardian.invite_accepted',
      entityType: 'guardians',
      entityId: Number(guardian.id),
      before: { inviteStatus: 'pending' },
      after: { inviteStatus: 'accepted', loginId },
    });

    return { loginId, fullName: guardian.fullName };
  });
}
