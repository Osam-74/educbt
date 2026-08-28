/**
 * Migration runner.
 *
 * Uses the UNPOOLED connection: PgBouncer runs in transaction mode and cannot
 * execute session-level statements, which DDL requires.
 *
 * Migrations are files in git, applied here, and never edited by hand against
 * production. The old system used self-recording migrations that marked
 * themselves as run — so when a table was later rebuilt, the migration saw
 * itself as done and never re-applied, leaving columns missing and queries
 * failing in ways nobody could trace.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;

  if (!url) {
    throw new Error('DATABASE_URL_UNPOOLED is required for migrations (not the -pooler host).');
  }

  const client = postgres(url, { max: 1 });

  try {
    console.log('Applying migrations…');
    await migrate(drizzle(client), { migrationsFolder: './drizzle' });

    console.log('Applying RLS policies…');
    const rls = readFileSync(join(process.cwd(), 'src/db/rls.sql'), 'utf8');
    await client.unsafe(rls);

    console.log('Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
