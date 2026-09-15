/** Recreate the local PLATFORM-ADMIN fixture for browser QA (id-agnostic:
 *  the QA scripts now look the id up by login_id, never hardcode it). */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@/db';
import { hashPassword } from '@/lib/auth/password';

async function main() {
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1 });
  const odb = drizzle(owner, { schema });
  const existing = await odb
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.loginId, 'PLATFORM-ADMIN'), isNull(schema.users.schoolId)))
    .limit(1);
  if (existing.length) {
    console.log('PLATFORM-ADMIN exists, id', existing[0]!.id);
  } else {
    const hash = await hashPassword('Qa-Platform-2026');
    const [row] = await odb
      .insert(schema.users)
      .values({ schoolId: null, role: 'platform_admin', loginId: 'PLATFORM-ADMIN', passwordHash: hash, mustChangePassword: false, status: 'active' })
      .returning({ id: schema.users.id });
    console.log('PLATFORM-ADMIN created, id', row!.id);
  }
  await owner.end();
}
main();
