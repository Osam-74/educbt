/**
 * Bootstrap the FIRST platform administrator.
 *
 *   npx tsx scripts/bootstrap-platform-admin.ts
 *
 * Production has no platform admin until this runs — /platform would have
 * nobody to sign in as. It connects with the OWNER credential
 * (DATABASE_URL_UNPOOLED) because provisioning accounts is exactly what the
 * owner credential is for; the application runtime never uses it.
 *
 * Behaviour:
 *   - idempotent-by-refusal: if the login ID already exists, nothing is
 *     written and the script says so;
 *   - the password is generated in memory, Argon2id-hashed, and printed
 *     ONCE — the database stores only the hash;
 *   - must_change_password is forced, so the first sign-in requires setting
 *     a new password.
 *
 * OWNER ACTION REQUIRED for production: run this from the controlled
 * migration/provisioning environment (the init workflow's pattern), not from
 * a developer laptop against production.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, isNull } from 'drizzle-orm';
import * as people from '../src/db/schema/people';
import { hashPassword, generateInitialPassword } from '../src/lib/auth/password';

const schema = { ...people };

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) {
    throw new Error('DATABASE_URL_UNPOOLED is required (the owner/provisioning credential).');
  }

  const loginId = (process.env.PLATFORM_ADMIN_LOGIN_ID ?? 'PLATFORM-ADMIN').trim().toUpperCase();

  const client = postgres(ownerUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const existing = await db
      .select({ id: people.users.id, role: people.users.role })
      .from(people.users)
      .where(and(eq(people.users.loginId, loginId), isNull(people.users.schoolId)))
      .limit(1);

    if (existing[0]) {
      console.log(
        `A platform account with sign-in ID "${loginId}" already exists (user #${existing[0].id}). ` +
          'Nothing was written. To issue a new password, use the account reset path instead.',
      );
      return;
    }

    const temporaryPassword = generateInitialPassword(12);
    const passwordHash = await hashPassword(temporaryPassword);

    const [created] = await db
      .insert(people.users)
      .values({
        schoolId: null,
        role: 'platform_admin',
        loginId,
        passwordHash,
        mustChangePassword: true,
        status: 'active',
      })
      .returning({ id: people.users.id });

    await db.insert(people.auditLog).values({
      schoolId: null,
      actorUserId: Number(created!.id),
      actorRole: 'platform_admin',
      action: 'platform_admin.bootstrapped',
      entityType: 'users',
      entityId: Number(created!.id),
      after: { loginId, temporaryPasswordIssued: true },
    });

    console.log('Platform administrator created.');
    console.log('');
    console.log(`  Sign-in ID   : ${loginId}`);
    console.log(`  Temporary password : ${temporaryPassword}`);
    console.log('');
    console.log('  Copy this password now. It is NOT stored and will not be shown again.');
    console.log('  The first sign-in will require setting a new password.');
    console.log(`  Sign in at: /sign-in on the platform host (no school address).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
