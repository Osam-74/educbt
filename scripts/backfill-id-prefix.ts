/**
 * One-off backfill: every school onboarded before the id_prefix column
 * existed gets a derived short prefix, using the exact same candidate logic
 * as new onboarding (see src/lib/platform/schools.ts) so a school's
 * abbreviation never depends on WHEN it joined the platform. Idempotent —
 * only touches rows where id_prefix is still null.
 *
 *   npx tsx scripts/backfill-id-prefix.ts
 *
 * NOTE: this uses postgres.js (raw TCP), which the sandbox environment
 * blocks on ports other than 443 — from the sandbox, run the same logic
 * through @neondatabase/serverless's HTTPS SQL client instead (see the
 * 2026-09-20 production run in the session log for the one-off script).
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, isNull } from 'drizzle-orm';

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED is required.');

  const { schema } = await import('@/db');
  const { candidateIdPrefixes } = await import('@/lib/platform/schools');
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const schools = await db.select({ id: schema.schools.id, name: schema.schools.name, idPrefix: schema.schools.idPrefix })
      .from(schema.schools).where(isNull(schema.schools.idPrefix));

    console.log(`${schools.length} school(s) need an id_prefix.`);

    for (const school of schools) {
      let chosen: string | null = null;
      for (const candidate of candidateIdPrefixes(school.name)) {
        const [taken] = await db.select({ id: schema.schools.id }).from(schema.schools)
          .where(eq(schema.schools.idPrefix, candidate));
        if (!taken) { chosen = candidate; break; }
      }
      if (!chosen) { console.error(`  could not derive a prefix for "${school.name}" (#${school.id})`); continue; }

      await db.update(schema.schools).set({ idPrefix: chosen }).where(eq(schema.schools.id, school.id));
      console.log(`  #${school.id} "${school.name}" -> ${chosen}`);
    }

    console.log('Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
