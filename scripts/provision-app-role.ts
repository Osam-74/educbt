/**
 * Provision the local application role that RLS is actually enforced against.
 *
 *   npx tsx scripts/provision-app-role.ts
 *
 * rls.sql documents these exact grants as comments; this runs them so
 * `npm run db:verify` can prove tenant isolation on a NON-superuser role.
 * Owners and superusers are exempt from RLS, so verifying as `postgres`
 * proves nothing.
 *
 * Local development only. On Neon the app role is provisioned by the
 * deployment environment, not by this script.
 */

import postgres from 'postgres';

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) throw new Error('DATABASE_URL_UNPOOLED is required.');

  const owner = postgres(ownerUrl, { max: 1 });

  try {
    // Idempotent: rerunning changes nothing.
    await owner`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'educbt_app') THEN
        CREATE ROLE educbt_app LOGIN PASSWORD 'educbt_local_app';
      END IF;
    END $$`;

    await owner`GRANT USAGE ON SCHEMA public TO educbt_app`;
    await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO educbt_app`;
    await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO educbt_app`;

    // Append-only audit: the application can insert and read the audit log,
    // never rewrite it.
    await owner`REVOKE UPDATE, DELETE ON audit_log FROM educbt_app`;

    // The app has no business touching migration bookkeeping.
    await owner`REVOKE ALL ON drizzle.__drizzle_migrations FROM educbt_app`;

    console.log('Role educbt_app is ready. Set DATABASE_URL_APP in .env.local:');
    console.log('  DATABASE_URL_APP="postgresql://educbt_app:educbt_local_app@localhost:5433/educbt"');
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  console.error('Provisioning failed:', err);
  process.exit(1);
});
