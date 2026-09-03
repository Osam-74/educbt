/**
 * Foundation verification.
 *
 *   npm run db:verify
 *
 * Run after every migration and before every deploy. It checks the things that
 * fail silently — tenant isolation, append-only audit, credential handling —
 * rather than the things a typecheck already catches.
 *
 * Needs TWO connections:
 *   DATABASE_URL_UNPOOLED  the owner, to set up fixtures
 *   DATABASE_URL_APP       the application role, which RLS actually applies to
 *
 * Running the isolation checks as the owner proves nothing: Postgres exempts
 * owners and superusers from RLS, so every policy would appear to pass while
 * doing nothing at all.
 */

import postgres from 'postgres';

let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  const viaAppVar = Boolean(process.env.DATABASE_URL_APP?.trim());
  const appUrl = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;

  if (!ownerUrl || !appUrl) {
    throw new Error('DATABASE_URL_UNPOOLED and DATABASE_URL_APP are both required.');
  }

  if (!viaAppVar) {
    // Verification as a superuser/owner proves nothing — those roles are
    // exempt from RLS, so every policy would pass while doing nothing. Say so
    // loudly instead of letting the run look meaningful.
    console.log(
      'NOTE  DATABASE_URL_APP is not set; verifying over DATABASE_URL.\n' +
      '      If that is an owner or superuser credential, the isolation checks\n' +
      '      below are meaningless — RLS does not apply to owners.',
    );
  }

  const owner = postgres(ownerUrl, { max: 1 });
  const app = postgres(appUrl, { max: 1 });

  try {
    // ── Is the app role actually subject to RLS? ──────────────────────────────
    // pg_roles carries both rolsuper and rolbypassrls. A role can be a plain
    // non-superuser and still carry BYPASSRLS — the check must catch both.
    const [who] = await app`SELECT current_user AS u, rolsuper AS su, rolbypassrls AS bpr
                            FROM pg_roles WHERE rolname = current_user`;

    check(
      'app role is not a superuser',
      who?.su === false,
      who?.su ? 'RLS is silently disabled for superusers' : '',
    );

    check(
      'app role does not carry BYPASSRLS',
      who?.bpr === false,
      who?.bpr ? 'BYPASSRLS ignores every row policy' : '',
    );

    const [owned] = await app`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = current_user`;

    check(
      'app role does not own the tables',
      (owned?.n ?? 0) === 0,
      (owned?.n ?? 0) > 0 ? 'owners bypass RLS unless FORCE is set' : '',
    );

    // ── Tenant isolation ─────────────────────────────────────────────────────
    const schools = await owner<{ id: number }[]>`SELECT id FROM schools ORDER BY id LIMIT 2`;

    if (schools.length < 2) {
      console.log('\nSKIP  isolation checks need at least two schools. Seed a second one.');
    } else {
      const a = schools[0]!;
      const b = schools[1]!;

      await app.begin(async (tx) => {
        const [none] = await tx`SELECT count(*)::int AS n FROM students`;
        check('unscoped read returns nothing (fails closed)', (none?.n ?? -1) === 0);
      });

      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${String(a.id)}, true)`;
        const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM students`;

        // bigint arrives as a STRING from the driver — JavaScript numbers cannot
        // hold the full range, so postgres.js does not silently narrow it.
        // Comparing with === against a number is always false and would make
        // this check pass or fail for the wrong reason.
        check(
          'scoped read returns only that school',
          rows.length > 0 && rows.every((r) => Number(r.school_id) === Number(a.id)),
          rows.length === 0 ? 'no students found — seed first' : '',
        );
      });

      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', ${String(b.id)}, true)`;
        const rows = await tx<{ school_id: string }[]>`SELECT school_id FROM students`;
        check(
          'a second school cannot see the first',
          rows.every((r) => Number(r.school_id) === Number(b.id)),
        );
      });

      await app.begin(async (tx) => {
        await tx`SELECT set_config('app.school_id', '999999', true)`;
        const [n] = await tx`SELECT count(*)::int AS n FROM students`;
        check('unknown tenant returns nothing', (n?.n ?? -1) === 0);
      });

      // The important one: can a scoped connection WRITE across the boundary?
      let blocked = false;
      try {
        await app.begin(async (tx) => {
          await tx`SELECT set_config('app.school_id', ${String(b.id)}, true)`;
          await tx`INSERT INTO students (school_id, admission_number, first_name, last_name)
                   VALUES (${a.id}, 'VERIFY-XT', 'Cross', 'Tenant')`;
        });
      } catch {
        blocked = true;
      }
      check('cross-tenant write is rejected', blocked);
    }

    // ── Audit log is append-only ─────────────────────────────────────────────
    let updateBlocked = false;
    try {
      await app`UPDATE audit_log SET action = 'tampered' WHERE id > 0`;
    } catch {
      updateBlocked = true;
    }
    check('audit log cannot be updated', updateBlocked);

    let deleteBlocked = false;
    try {
      await app`DELETE FROM audit_log WHERE id > 0`;
    } catch {
      deleteBlocked = true;
    }
    check('audit log cannot be deleted', deleteBlocked);

    // ── Credentials ──────────────────────────────────────────────────────────
    const hashes = await owner<{ password_hash: string }[]>`
      SELECT password_hash FROM users LIMIT 20`;

    check(
      'all passwords are argon2id',
      hashes.length > 0 && hashes.every((h) => h.password_hash.startsWith('$argon2id$')),
    );

    // ── Schema invariants ────────────────────────────────────────────────────
    const [rlsOff] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_tables t
      JOIN pg_class c ON c.relname = t.tablename
      WHERE t.schemaname = 'public'
        AND t.tablename IN ('students','staff','users','enrollments','classes','subjects')
        AND c.relrowsecurity = false`;

    check('RLS enabled on every core table', (rlsOff?.n ?? 1) === 0);

    const [notForced] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('students','staff','users','enrollments')
        AND c.relforcerowsecurity = false`;

    check('RLS is FORCEd (applies to the table owner too)', (notForced?.n ?? 1) === 0);

    // Catalog-driven guard: the lists above are a snapshot, but a NEW tenant
    // table must not reach production quietly unguarded. Any public table
    // (only 'sessions' is exempt, by documented design) must have RLS
    // enabled, FORCEd, and at least one policy. A new schema table missing
    // from rls.sql fails HERE — no maintainer has to remember the list.
    const [unguarded] = await owner<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM pg_tables t
      JOIN pg_class c ON c.relname = t.tablename
      WHERE t.schemaname = 'public'
        AND t.tablename <> 'sessions'
        AND (
          c.relrowsecurity = false
          OR c.relforcerowsecurity = false
          OR NOT EXISTS (
            SELECT 1 FROM pg_policies p
            WHERE p.schemaname = t.schemaname AND p.tablename = t.tablename
          )
        )`;
    check(
      'every public table (catalog-checked) is RLS-forced with a policy',
      (unguarded?.n ?? 1) === 0,
    );
  } finally {
    await owner.end();
    await app.end();
  }

  console.log(
    failures === 0
      ? '\nAll checks passed. The foundation is safe to build on.'
      : `\n${failures} check(s) FAILED. Do not build on this until they pass.`,
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Verification error:', err);
  process.exit(1);
});
