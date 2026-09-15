/**
 * Attach a recovery email to the ONE platform administrator.
 *
 *   PLATFORM_ADMIN_LOGIN_ID=... PLATFORM_ADMIN_EMAIL=you@example.com \
 *     npx tsx scripts/attach-platform-admin-email.ts
 *
 * OWNER ACTION, run from the controlled provisioning environment (the
 * init-workflow pattern — see bootstrap-platform-admin.ts). The script exists
 * because the platform admin owns no tenant, so the normal in-app profile
 * flow (which is reachable only behind a school/platform session) is a poor
 * fit for the very first recovery; and the person running the script IS the
 * mailbox owner, so the address is marked VERIFIED here
 * (email_verified_at = now). Verification via the app flow always starts
 * UNVERIFIED.
 *
 * Idempotent: re-running with the same address is a no-op; the address is
 * globally unique (users_email_lc_uq) and a conflict with ANOTHER account
 * aborts with an error instead of stealing it.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import * as people from '../src/db/schema/people';

const schema = { ...people };

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) {
    throw new Error('DATABASE_URL_UNPOOLED is required (the owner/provisioning credential).');
  }

  const loginId = (process.env.PLATFORM_ADMIN_LOGIN_ID ?? 'PLATFORM-ADMIN').trim().toUpperCase();
  const email = (process.env.PLATFORM_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('PLATFORM_ADMIN_EMAIL must be a valid address.');
  }

  const client = postgres(ownerUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      const [admin] = await tx
        .select({ id: people.users.id, email: people.users.email })
        .from(people.users)
        .where(
          and(
            eq(people.users.loginId, loginId),
            isNull(people.users.schoolId),
            eq(people.users.role, 'platform_admin'),
          ),
        )
        .limit(1);

      if (!admin) {
        throw new Error(`No platform-admin account found for login ID ${loginId}.`);
      }

      if (admin.email === email) {
        console.log(`Recovery email for ${loginId} is already ${email}. Nothing to do.`);
        return;
      }

      // Duplicate on another account? The unique index aborts the
      // transaction; surface it as a plain instruction, not a stack trace.
      try {
        await tx
          .update(people.users)
          .set({ email, emailVerifiedAt: new Date() })
          .where(eq(people.users.id, admin.id));

        await tx.insert(people.auditLog).values({
          schoolId: null,
          actorUserId: admin.id,
          actorRole: 'platform_admin',
          action: 'auth.recovery_email_attached',
          entityType: 'users',
          entityId: Number(admin.id),
          before: { email: admin.email },
          after: { email, verifiedBy: 'owner-script' },
        });
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: string }).code === '23505'
        ) {
          throw new Error('That email address is already in use on another account.');
        }
        throw error;
      }

      console.log(`Recovery email for ${loginId} is now ${email} (verified, owner-attached).`);
      console.log('Password-reset links will be delivered to this mailbox.');
    });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
