/**
 * The optional "set a new password" offer shown after a school moves over from the WordPress plugin.
 * It is an offer, never a requirement: the person keeps working with the password they already know, and
 * either choice is final. Free of next/* imports so it can be tested from plain scripts.
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { forSchool, schema } from '@/db';

/** True while this person arrived with their old password and has neither changed it nor kept it. */
export async function shouldOfferNewPassword(actor: { id: number; schoolId: number }): Promise<boolean> {
  const rows = await forSchool(actor.schoolId, (tx) =>
    tx.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.id, actor.id), isNotNull(schema.users.passwordCarriedAt), isNull(schema.users.passwordPromptDismissedAt)))
      .limit(1));
  return rows.length === 1;
}

/** "Keep my password": never offered again. Changes nothing else and cannot affect anyone but the caller. */
export async function dismissPasswordOffer(actor: { id: number; schoolId: number }): Promise<void> {
  await forSchool(actor.schoolId, (tx) =>
    tx.update(schema.users).set({ passwordPromptDismissedAt: new Date() })
      .where(and(eq(schema.users.id, actor.id), isNotNull(schema.users.passwordCarriedAt), isNull(schema.users.passwordPromptDismissedAt))));
}
