/**
 * scripts/db-verify-fixtures.ts — temporary fixtures for db:verify on an
 * EMPTY production database.
 *
 *   DATABASE_URL_UNPOOLED=... npx tsx scripts/db-verify-fixtures.ts --setup
 *   DATABASE_URL_UNPOOLED=... npx tsx scripts/db-verify-fixtures.ts --teardown
 *
 * `npm run db:verify` needs a minimum of real data to prove anything: tenant
 * isolation requires TWO schools with students, and the argon2id check requires
 * at least one password hash. On a fresh production database none of that
 * exists — and production must NOT be seeded with demo data (no DEMO001, no
 * test students left behind).
 *
 * So the production verification workflow creates the smallest possible set of
 * clearly-marked fixture rows, runs db:verify, and removes them again:
 *
 *   schools  VFY-SUPPLIER, VFY-OTHERSIDE   (fixture-marked codes)
 *   students VFY-SUP-1, VFY-OTH-1          (one per school)
 *   user     vfy-user@fixture               (argon2id hash, random password)
 *
 * Guarantees:
 *   - deterministic identities (fixed codes/login ids — nothing random that
 *     could survive a cleanup and collide on a later run)
 *   - rerun-safe: --setup cleans its own leftovers first, then inserts
 *   - --teardown deletes by exact fixture identities and FAILS if anything
 *     marked VFY- remains
 *   - every row carries the VFY- marker; a stray fixture is grep-able
 *
 * Runs as the OWNER via DATABASE_URL_UNPOOLED (never the app role) —
 * provisioning fixtures is owner work, like seeding.
 */

import postgres from 'postgres';
import { hashPassword } from '../src/lib/auth/password';

const SCHOOLS = [
  { code: 'VFY-SUPPLIER', name: 'Verify Fixture School A' },
  { code: 'VFY-OTHERSIDE', name: 'Verify Fixture School B' },
] as const;

const STUDENTS = [
  { code: 'VFY-SUPPLIER', admission: 'VFY-SUP-1', first: 'Verify', last: 'Supplier' },
  { code: 'VFY-OTHERSIDE', admission: 'VFY-OTH-1', first: 'Verify', last: 'Other' },
] as const;

const FIXTURE_LOGIN = 'vfy-user@fixture';

function fail(message: string): never {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

/** Remove every row this script could have created. Idempotent. */
async function clean(sql: postgres.Sql) {
  await sql`DELETE FROM users WHERE login_id = ${FIXTURE_LOGIN}`;
  await sql`DELETE FROM students WHERE admission_number LIKE 'VFY-%'`;
  await sql`DELETE FROM schools WHERE code IN ('VFY-SUPPLIER', 'VFY-OTHERSIDE')`;
}

async function assertClean(sql: postgres.Sql, label: string) {
  const [left] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM (
      SELECT 1 FROM schools WHERE code LIKE 'VFY-%'
      UNION ALL SELECT 1 FROM students WHERE admission_number LIKE 'VFY-%'
      UNION ALL SELECT 1 FROM users WHERE login_id = ${FIXTURE_LOGIN}
    ) leftovers`;
  if ((left?.n ?? 0) > 0) {
    fail(`${label}: ${left?.n} fixture row(s) remain after cleanup. Production must not keep verification fixtures — investigate manually.`);
  }
  console.log(`${label}: 0 fixture rows remain.`);
}

async function main() {
  const mode = process.argv[2];
  if (mode !== '--setup' && mode !== '--teardown') {
    fail('usage: db-verify-fixtures.ts --setup | --teardown');
  }

  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) fail('DATABASE_URL_UNPOOLED is required (fixtures are created and removed by the owner).');

  const sql = postgres(url, { max: 1 });

  try {
    if (mode === '--teardown') {
      await clean(sql);
      await assertClean(sql, 'teardown');
      console.log('Teardown complete. The database holds no verification fixtures.');
      return;
    }

    // ── setup ────────────────────────────────────────────────────────────────
    // Rerun-safe: clear our own leftovers first, so a retry after a partial
    // run cannot collide with unique constraints from the previous attempt.
    await clean(sql);

    for (const s of SCHOOLS) {
      await sql`INSERT INTO schools (code, name, status) VALUES (${s.code}, ${s.name}, 'active')`;
    }

    for (const st of STUDENTS) {
      await sql`
        INSERT INTO students (school_id, admission_number, first_name, last_name, status)
        SELECT id, ${st.admission}, ${st.first}, ${st.last}, 'active'
        FROM schools WHERE code = ${st.code}`;
    }

    // The hash is real argon2id of a throwaway random password — the credential
    // check must see genuine hashes, but this account can never be used to
    // sign in from anywhere: the password is discarded and the row is deleted
    // minutes later.
    const throwaway = `vfy-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const hash = await hashPassword(throwaway);
    await sql`
      INSERT INTO users (school_id, role, login_id, password_hash, must_change_password, status)
      SELECT id, 'teacher', ${FIXTURE_LOGIN}, ${hash}, true, 'active'
      FROM schools WHERE code = 'VFY-SUPPLIER'`;

    const [counts] = await sql<{ schools: number; students: number; users: number }[]>`
      SELECT
        (SELECT count(*)::int FROM schools WHERE code LIKE 'VFY-%') AS schools,
        (SELECT count(*)::int FROM students WHERE admission_number LIKE 'VFY-%') AS students,
        (SELECT count(*)::int FROM users WHERE login_id = ${FIXTURE_LOGIN}) AS users`;
    const expected = counts?.schools === 2 && counts?.students === 2 && counts?.users === 1;
    if (!expected) {
      fail(
        `fixture insert incomplete: schools=${counts?.schools} (want 2), students=${counts?.students} (want 2), users=${counts?.users} (want 1). Running --teardown and retrying is safe.`,
      );
    }
    console.log(
      `Fixtures ready: ${counts?.schools} schools, ${counts?.students} students, ${counts?.users} user. ` +
      'Run db:verify now, then --teardown.',
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Fixture error:', err);
  process.exit(1);
});
