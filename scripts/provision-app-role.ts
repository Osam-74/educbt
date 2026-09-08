/**
 * Provision the least-privileged application role that RLS is enforced
 * against.
 *
 *   DATABASE_URL_UNPOOLED=... npm run db:provision-app-role
 *
 * rls.sql documents these exact grants as comments; this runs them so
 * `npm run db:verify` can prove tenant isolation on a NON-superuser role.
 * Owners and superusers are exempt from RLS, so verifying as the owner
 * proves nothing.
 *
 * Two modes:
 *
 *   LOCAL (default)  — no EDUCBT_APP_PASSWORD set and the target is
 *   localhost: uses the documented local dev password. Fine for a
 *   single-developer machine; refused for anything remote.
 *
 *   PRODUCTION      — EDUCBT_APP_PASSWORD is provided (and REQUIRED for
 *   non-local hosts). The password is read from the environment, applied via
 *   ALTER/CREATE ROLE, and never echoed. GitHub Actions masks secret values
 *   in logs automatically; this script additionally never prints SQL text,
 *   connection strings, or passwords. Rotation: re-running with a new
 *   EDUCBT_APP_PASSWORD rotates the existing role's password — grants are
 *   re-applied idempotently either way.
 *
 * The role remains:
 *   - NOT superuser, NOT database owner, NO BYPASSRLS
 *   - least-privilege CRUD on public tables
 *   - audit_log: SELECT + INSERT only (append-only)
 *   - no access to drizzle migration bookkeeping
 */

import postgres from 'postgres';
import { parsePgUri, describePgUri } from '../src/lib/backup/pg-uri';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOCAL_DEV_PASSWORD = 'educbt_local_app';
const MIN_PROD_PASSWORD_LENGTH = 20;

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) fail('DATABASE_URL_UNPOOLED is required.');

  const uri = parsePgUri(ownerUrl, 'DATABASE_URL_UNPOOLED');
  const isLocal = LOCAL_HOSTS.has(uri.host.toLowerCase());
  const envPassword = process.env.EDUCBT_APP_PASSWORD?.trim();

  let password: string;
  if (isLocal && !envPassword) {
    password = LOCAL_DEV_PASSWORD;
    console.log('INFO  local target: using the documented local dev password.');
  } else {
    if (!envPassword) {
      fail(
        `refusing to provision ${uri.host} with a hardcoded password. ` +
        'Set EDUCBT_APP_PASSWORD to a strong generated secret (≥ ' + MIN_PROD_PASSWORD_LENGTH + ' chars).',
      );
    }
    if (envPassword.length < MIN_PROD_PASSWORD_LENGTH) {
      fail(`EDUCBT_APP_PASSWORD must be at least ${MIN_PROD_PASSWORD_LENGTH} characters for production use.`);
    }
    password = envPassword;
  }

  const owner = postgres(ownerUrl, { max: 1 });

  try {
    // Role body without the password — password is applied separately below so
    // the secret never sits inside a DO block string or a logged statement.
    await owner`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'educbt_app') THEN
        CREATE ROLE educbt_app LOGIN;
      END IF;
    END $$`;

    // Password application. postgres.js cannot parameterise utility DDL, so
    // this is the one place a literal is unavoidable — it is escaped, the
    // statement is never logged, and GitHub Actions masks the secret value in
    // any output regardless.
    const escaped = password.replace(/'/g, "''");
    await owner.unsafe(`ALTER ROLE educbt_app PASSWORD '${escaped}'`);

    await owner`GRANT USAGE ON SCHEMA public TO educbt_app`;
    await owner`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO educbt_app`;
    await owner`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO educbt_app`;

    // Append-only audit: the application can insert and read the audit log,
    // never rewrite it.
    await owner`REVOKE UPDATE, DELETE ON audit_log FROM educbt_app`;

    // The app has no business touching migration bookkeeping.
    await owner`REVOKE ALL ON drizzle.__drizzle_migrations FROM educbt_app`;

    // Prove the posture we just claimed.
    const [role] = await owner<{ super: boolean; bypass: boolean; login: boolean }[]>`
      SELECT rolsuper AS super, rolbypassrls AS bypass, rolcanlogin AS login
      FROM pg_roles WHERE rolname = 'educbt_app'`;
    if (role?.super || role?.bypass || !role?.login) {
      fail('role educbt_app is not least-privileged (superuser/BYPASSRLS/no-login). Refusing to finish.');
    }

    console.log(`INFO  role educbt_app provisioned on ${describePgUri(ownerUrl)} (not superuser, no BYPASSRLS, audit UPDATE/DELETE revoked).`);

    if (isLocal && !envPassword) {
      console.log('Role educbt_app is ready. Set DATABASE_URL_APP in .env.local:');
      console.log(`  DATABASE_URL_APP="postgresql://educbt_app:${LOCAL_DEV_PASSWORD}@${uri.host}:${uri.port}/${uri.dbname}"`);
    } else {
      // Production: compose the app-role URL from the secret + these hosts.
      // Hostnames are not credentials; the password is never printed.
      const pooledHost = uri.host.includes('-pooler')
        ? uri.host
        : `${uri.host.replace(/\.neon\.tech$/, '')}-pooler.neon.tech`;
      console.log('\nEndpoint report (hostnames only — no credentials):');
      console.log(`  pooled (runtime):   postgresql://educbt_app:<password>@${pooledHost}/${uri.dbname}?sslmode=verify-full`);
      console.log(`  direct (tooling):  postgresql://educbt_app:<password>@${uri.host}/${uri.dbname}?sslmode=verify-full`);
      console.log('\nSet the pooled URL as the DATABASE_URL_APP repository secret (password from EDUCBT_APP_PASSWORD).');
    }
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  // Never print err.query / err.params — a failed ALTER could otherwise echo
  // the password. The message alone is enough to diagnose.
  console.error('Provisioning failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
