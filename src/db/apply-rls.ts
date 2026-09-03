/**
 * Standalone RLS applier.
 *
 *   npm run db:rls
 *
 * Applies src/db/rls.sql as the owner. The file is fully idempotent — every
 * policy is dropped and recreated, so this is safe to re-run and is the fast
 * path when a policy changed but no schema migration did. `db:migrate` runs
 * the same statement after migrations, so the two paths can never diverge.
 *
 * Uses the UNPOOLED owner connection: DDL and policy changes need a real
 * session, and the application role must never hold ALTER rights anyway.
 */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED;

  if (!url) {
    throw new Error('DATABASE_URL_UNPOOLED is required to apply RLS (not the -pooler host).');
  }

  const client = postgres(url, { max: 1 });

  try {
    const rls = readFileSync(join(process.cwd(), 'src/db/rls.sql'), 'utf8');
    await client.unsafe(rls);
    console.log('RLS policies applied.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Applying RLS failed:', err);
  process.exit(1);
});
