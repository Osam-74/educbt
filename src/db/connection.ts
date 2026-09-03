/**
 * The database connection contract.
 *
 * Pure logic, no side effects, no imports that touch the network — so the
 * contract itself can be unit-tested without a database or real credentials
 * (src/db/test-config.ts).
 *
 * Exactly three connections exist, and mixing them is the one configuration
 * mistake that silently defeats Row-Level Security:
 *
 *   DATABASE_URL_APP       runtime. Pooled, least-privileged educbt_app.
 *                           RLS applies. What the application runs on.
 *   DATABASE_URL_UNPOOLED   owner/admin. Migrations, DDL, provisioning,
 *                           test fixtures. Scripts and tooling only — it is
 *                           never imported by application code.
 *   DATABASE_URL            development convenience only. The fallback the
 *                           runtime may use BEFORE the app role is
 *                           provisioned. In production it is never used.
 *
 * PostgreSQL exempts owners and superusers from RLS. A production runtime that
 * quietly connected as the owner would pass every page render while every
 * tenant policy did nothing — so in production the app-role connection is
 * REQUIRED, and its absence fails the boot loudly rather than degrading.
 */

// An index-signature record, not a closed shape, so `process.env` satisfies
// it without a cast and tests can pass plain literal objects.
export type ConnectionEnv = Record<string, string | undefined>;

export type ResolvedRuntimeConnection =
  | { ok: true; url: string; viaAppRole: boolean; production: boolean }
  | { ok: false; error: string };

const NOT_SET_HINT =
  'Set DATABASE_URL_APP to the POOLED endpoint of the least-privilege educbt_app ' +
  'role (see scripts/provision-app-role.ts). The owner credential must never run ' +
  'the application: owners and superusers bypass Row-Level Security.';

/**
 * Which URL the application runtime may connect with.
 *
 * Production is fail-closed: DATABASE_URL_APP or nothing. Development may
 * fall back to DATABASE_URL — documented in README — because a fresh clone has
 * no educbt_app role yet, and local convenience must not weaken the
 * production gate.
 */
export function resolveRuntimeDatabaseUrl(
  env: ConnectionEnv,
  nodeEnv: string | undefined,
): ResolvedRuntimeConnection {
  const production = nodeEnv === 'production';
  const app = env.DATABASE_URL_APP?.trim();
  const general = env.DATABASE_URL?.trim();

  if (production) {
    if (app) return { ok: true, url: app, viaAppRole: true, production: true };
    // Deliberately NOT falling back to DATABASE_URL: in production that name
    // is conventionally the owner/admin credential, and running with it would
    // silently disable every RLS policy. The error names the variable to set
    // but never echoes connection strings, which contain passwords.
    return {
      ok: false,
      error:
        'Production database runtime requires the application-role connection. ' +
        `DATABASE_URL_APP is not set. ${NOT_SET_HINT}`,
    };
  }

  if (app) return { ok: true, url: app, viaAppRole: true, production: false };
  if (general) {
    return { ok: true, url: general, viaAppRole: false, production: false };
  }
  return {
    ok: false,
    error:
      'No database URL is set. Set DATABASE_URL_APP (preferred, even in ' +
      'development) or DATABASE_URL. Use the POOLED Neon endpoint ' +
      '(-pooler host); the unpooled one is for migrations only.',
  };
}
