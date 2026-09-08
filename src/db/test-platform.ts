/**
 * Platform administration & school onboarding suite.
 *
 *   npm run test:platform
 *
 * Proves the tenant-creation path end-to-end, against the REAL educbt_app
 * role (RLS on) — the same contract the portal runs under:
 *
 *   1.  A platform admin can create a school WITH its first principal in one
 *       atomic operation (school + principal + staff + audit, or nothing).
 *   2.  The principal's credential handling: Argon2id only, forced password
 *       change, plaintext stored nowhere (row, audit, or anywhere else).
 *   3.  Friendly refusals: duplicate school code / subdomain, validation.
 *   4.  Role isolation: principal / exam officer / teacher / student actors
 *       are refused by the SERVICE, before any database work.
 *   5.  Suspension takes effect immediately: an existing session stops
 *       resolving; reactivation restores it.
 *   6.  Audit trail: created / principal_created / suspended / reactivated
 *       all recorded, password-free.
 *   7.  Tenancy still holds: School A cannot see School B's users, while the
 *       platform path lists both.
 *
 * Fixture standard: dedicated private schools (PLT-* codes), deleted at start
 * so reruns are safe, no production constraints weakened. The application-role
 * modules under test connect via DATABASE_URL_APP; fixtures and cross-tenant
 * verification use the owner connection, which the application never holds.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as core from './schema/core';
import * as people from './schema/people';
import { forSchool } from '@/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { authenticateCredentials } from '@/lib/auth/credentials';
import { createSession, readSessionUser } from '@/lib/auth/session-store';
import type { PlatformActor } from '@/lib/platform/session';
import {
  createSchoolWithPrincipal,
  createPrincipalForSchool,
  setSchoolStatus,
  listSchools,
  platformOverview,
  schoolDetail,
  DuplicateValueError,
  OnboardingValidationError,
  PlatformPermissionError,
} from '@/lib/platform/schools';

const schema = { ...core, ...people };

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const CODE_A = 'PLT-A';
const CODE_B = 'PLT-B';
const CODE_DUP = 'PLT-A';          // deliberately the same as A
const CODE_ATOMIC = 'PLT-ATOMIC';  // must never survive
const CODE_NEWLOGIN = 'PLT-NEWLOGIN';

const adminActor = (userId: number): PlatformActor => ({
  userId,
  loginId: 'PLT-ADMIN',
  role: 'platform_admin',
});

const wrongActor = (userId: number, role: string): PlatformActor & { role: string } =>
  ({ userId, loginId: `PLT-${role}`, role } as never);

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) throw new Error('DATABASE_URL_UNPOOLED required.');
  const owner = postgres(ownerUrl, { max: 1 });
  const odb = drizzle(owner, { schema });

  // ── Fixture: rerun-safe cleanup of this suite's private tenants ────────────
  await odb.delete(core.schools).where(
    inArray(core.schools.code, [CODE_A, CODE_B, CODE_ATOMIC, CODE_NEWLOGIN]),
  );

  // The platform admin account the service runs as. Deleted first so the
  // suite is rerun-safe; recreated with a fixed test password.
  await odb.delete(people.users).where(and(eq(people.users.loginId, 'PLT-ADMIN'), eq(people.users.role, 'platform_admin')));
  const adminHash = await hashPassword('Fixt-Plat!234');
  const [admin] = await odb
    .insert(people.users)
    .values({
      schoolId: null,
      role: 'platform_admin',
      loginId: 'PLT-ADMIN',
      passwordHash: adminHash,
      mustChangePassword: false,
      status: 'active',
    })
    .returning({ id: people.users.id });
  const adminId = Number(admin!.id);
  const actor = adminActor(adminId);

  try {
    // ── 1–6. One coherent onboarding: school + principal + credential rules ─
    let result: Awaited<ReturnType<typeof createSchoolWithPrincipal>>;
    try {
      result = await createSchoolWithPrincipal(actor, {
        name: 'Platform Fixture School A',
        code: CODE_A,
        email: 'office@plt-a.test',
        phone: '0800 000 0001',
        subdomain: 'plt-a',
        status: 'active',
        principalFirstName: 'Amaka',
        principalLastName: 'Obi',
        principalLoginId: 'a.obi@plt-a.test',
      });
    } catch (error) {
      check('platform admin can create School A', false, String(error));
      throw error;
    }

    check('platform admin can create School A (1)', true);
    check(
      'temporary password returned, 12 chars, not stored anywhere obvious',
      typeof result.temporaryPassword === 'string' && result.temporaryPassword.length === 12,
    );

    const [schoolA] = await odb.select().from(core.schools).where(eq(core.schools.code, CODE_A)).limit(1);
    const schoolAId = Number(schoolA!.id);
    check('school row exists with the onboarding fields', schoolA!.status === 'active' && schoolA!.subdomain === 'plt-a');

    const [principal] = await odb
      .select()
      .from(people.users)
      .where(eq(people.users.loginId, 'a.obi@plt-a.test'))
      .limit(1);

    check('initial Principal created (2)', !!principal);
    check('principal has correct schoolId (3)', Number(principal!.schoolId) === schoolAId);
    check('password is Argon2id (4)', principal!.passwordHash.startsWith('$argon2id$'));
    check('must_change_password set (5)', principal!.mustChangePassword === true);

    // (6) plaintext is nowhere in the row, and the returned credential works.
    const rowJson = JSON.stringify(principal);
    check(
      'plaintext password not stored in any user column (6)',
      !rowJson.includes(result.temporaryPassword),
    );
    check(
      'returned temporary password actually verifies (6)',
      await verifyPassword(principal!.passwordHash, result.temporaryPassword),
    );

    const [staffRow] = await odb
      .select()
      .from(people.staff)
      .where(eq(people.staff.schoolId, schoolAId))
      .limit(1);
    check('staff record links the principal to the tenant', !!staffRow && Number(staffRow!.userId) === Number(principal!.id));

    // ── 7. Duplicate school code: friendly, no raw database error ───────────
    let dupFailed = false;
    let dupMessage = '';
    try {
      await createSchoolWithPrincipal(actor, {
        name: 'Duplicate Code School',
        code: CODE_DUP,
        principalFirstName: 'Test',
        principalLastName: 'Case',
        principalLoginId: 'dup@plt.test',
      });
    } catch (error) {
      dupFailed = error instanceof DuplicateValueError;
      dupMessage = error instanceof Error ? error.message : String(error);
    }
    check(
      'duplicate school code rejected, friendly (7)',
      dupFailed && /already in use/.test(dupMessage) && !/SQLSTATE|duplicate key|constraint/i.test(dupMessage),
      dupMessage,
    );
    const dupCount = await odb.select({ id: people.users.id }).from(people.users).where(eq(people.users.loginId, 'dup@plt.test'));
    check('rejected onboarding left no user behind (7)', dupCount.length === 0);

    // ── 8. Atomicity ────────────────────────────────────────────────────────
    let atomicFailed = false;
    try {
      // Valid distinct code, but a subdomain already owned by School A → the
      // SCHOOL insert fails and everything after it must vanish with it.
      await createSchoolWithPrincipal(actor, {
        name: 'Atomicity Fixture School',
        code: CODE_ATOMIC,
        subdomain: 'plt-a',
        principalFirstName: 'Test',
        principalLastName: 'Case',
        principalLoginId: 'atomic@plt.test',
      });
    } catch (error) {
      atomicFailed = error instanceof DuplicateValueError;
    }
    const atomicSchool = await odb.select({ id: core.schools.id }).from(core.schools).where(eq(core.schools.code, CODE_ATOMIC));
    const atomicUser = await odb.select({ id: people.users.id }).from(people.users).where(eq(people.users.loginId, 'atomic@plt.test'));
    check(
      'school+principal creation is atomic (8)',
      atomicFailed && atomicSchool.length === 0 && atomicUser.length === 0,
    );

    // And the principal step rolls back cleanly too (duplicate loginId inside
    // one tenant, through the shared inner path).
    const staffBefore = await odb.select({ id: people.staff.id }).from(people.staff).where(eq(people.staff.schoolId, schoolAId));
    let principalDupFailed = false;
    try {
      await createPrincipalForSchool(actor, schoolAId, {
        name: 'Platform Fixture School A',
        code: CODE_A,
        principalFirstName: 'Second',
        principalLastName: 'Principal',
        principalLoginId: 'a.obi@plt-a.test',
      });
    } catch (error) {
      principalDupFailed = error instanceof DuplicateValueError;
    }
    const staffAfter = await odb.select({ id: people.staff.id }).from(people.staff).where(eq(people.staff.schoolId, schoolAId));
    check(
      'principal step rolls back cleanly on duplicate sign-in ID (8)',
      principalDupFailed && staffBefore.length === staffAfter.length,
    );

    // ── Validation refusals (no database work) ───────────────────────────────
    for (const [label, subdomain] of [
      ['reserved subdomain refused', 'www'],
      ['malformed subdomain refused', 'Bad_Sub'],
      ['short subdomain refused', 'ab'],
    ] as const) {
      let rejected = false;
      try {
        await createSchoolWithPrincipal(actor, {
          name: 'Validation Fixture School',
          code: CODE_NEWLOGIN,
          subdomain,
          principalFirstName: 'Test',
          principalLastName: 'Case',
          principalLoginId: 'validate@plt.test',
        });
      } catch (error) {
        rejected = error instanceof OnboardingValidationError;
      }
      const leak = await odb.select({ id: core.schools.id }).from(core.schools).where(eq(core.schools.code, CODE_NEWLOGIN));
      check(`${label} (14)`, rejected && leak.length === 0);
    }

    // ── 9–11. Role isolation: the SERVICE refuses school actors ─────────────
    for (const role of ['principal', 'exam_officer', 'teacher', 'student', 'parent']) {
      let refused = false;
      try {
        await createSchoolWithPrincipal(wrongActor(adminId, role), {
          name: 'Forbidden School',
          code: 'PLT-FORBIDDEN',
          principalFirstName: 'Test',
          principalLastName: 'Case',
          principalLoginId: 'forbidden@plt.test',
        });
      } catch (error) {
        refused = error instanceof PlatformPermissionError;
      }
      const forbidden = await odb.select({ id: core.schools.id }).from(core.schools).where(eq(core.schools.code, 'PLT-FORBIDDEN'));
      check(`${role} cannot access the platform service (9–11)`, refused && forbidden.length === 0);
    }

    // ── School B for tenancy checks ─────────────────────────────────────────
    const resultB = await createSchoolWithPrincipal(actor, {
      name: 'Platform Fixture School B',
      code: CODE_B,
      subdomain: 'plt-b',
      status: 'active',
      principalFirstName: 'Bola',
      principalLastName: 'Ada',
      principalLoginId: 'b.ada@plt-b.test',
    });
    const [schoolB] = await odb.select().from(core.schools).where(eq(core.schools.code, CODE_B)).limit(1);
    const schoolBId = Number(schoolB!.id);
    check('School B onboarded (platform can serve many tenants)', !!schoolB);

    // ── 17. School A cannot see School B's data (tenant RLS) ────────────────
    // Platform-admin rows are visible to the application role WITHOUT a
    // tenant by design — that is the narrow pre-auth lookup sign-in needs
    // (platform_admin_lookup, rls.sql). The tenancy claim is about SCHOOL
    // accounts: within A's scope, A's principal is visible and B's is not.
    const visibleUsers = await forSchool(schoolAId, async (tx) =>
      tx.select({ loginId: people.users.loginId }).from(people.users),
    );
    const visibleIds = visibleUsers.map((u) => u.loginId);
    check(
      'School A cannot see School B users (17)',
      visibleIds.includes('a.obi@plt-a.test') && !visibleIds.includes('b.ada@plt-b.test'),
      visibleIds.join(','),
    );
    const visibleStudents = await forSchool(schoolAId, async (tx) =>
      tx.select({ id: people.students.id }).from(people.students),
    );
    check('School A sees only its own (empty) student roster (17)', visibleStudents.length === 0);

    // ── 18. The approved platform path lists both tenants ────────────────────
    const listed = await listSchools(actor);
    check(
      'platform admin lists both tenants through the platform path (18)',
      [CODE_A, CODE_B].every((c) => listed.some((s) => s.code === c)) &&
        typeof listed.find((s) => s.code === CODE_A)?.principalName === 'string',
    );
    const overview = await platformOverview(actor);
    check('dashboard overview counts include the fixture tenants (18)', overview.total >= 2 && overview.active >= 2);
    const detail = await schoolDetail(actor, schoolAId);
    check('school detail shows the administrator and setup counts', detail.principalLoginId === 'a.obi@plt-a.test' && detail.setup.staff === 1);

    // ── 12–14. Suspension lifecycle against a LIVE session ──────────────────
    const signedIn = await authenticateCredentials({
      loginId: 'a.obi@plt-a.test',
      password: result.temporaryPassword,
      schoolId: schoolAId,
    });
    check('principal can sign in with the temporary password (12)', !!signedIn);

    const { token } = await createSession(Number(signedIn.id), null, 'platform-test');
    const liveBefore = await readSessionUser(token);
    check('session resolves before suspension (12)', !!liveBefore);

    await setSchoolStatus(actor, {
      schoolId: schoolAId,
      status: 'suspended',
      reason: 'Suspension fixture for platform suite',
      confirm: true,
    });
    const [suspendedRow] = await odb.select({ status: core.schools.status }).from(core.schools).where(eq(core.schools.id, schoolAId));
    check('school suspension takes effect (12)', suspendedRow!.status === 'suspended');

    const deadAfterSuspend = await readSessionUser(token);
    check('existing session stops resolving after suspension (13)', deadAfterSuspend === null);

    await setSchoolStatus(actor, {
      schoolId: schoolAId,
      status: 'active',
      reason: 'Reactivation fixture for platform suite',
      confirm: true,
    });
    const liveAfterReact = await readSessionUser(token);
    const [reactivatedRow] = await odb.select({ status: core.schools.status }).from(core.schools).where(eq(core.schools.id, schoolAId));
    check('reactivation restores access immediately (14)', !!liveAfterReact && reactivatedRow!.status === 'active');

    // Refuse to suspend twice without confirmation / with archived status
    let statusGuardHeld = true;
    try {
      await setSchoolStatus(actor, {
        schoolId: schoolAId,
        status: 'suspended',
        reason: 'Unconfirmed suspension attempt',
        confirm: false,
      });
      statusGuardHeld = false;
    } catch (error) {
      statusGuardHeld = statusGuardHeld && error instanceof OnboardingValidationError;
    }
    try {
      await setSchoolStatus(actor, {
        schoolId: schoolAId,
        status: 'archived' as never,
        reason: 'Archived is not a platform UI action',
        confirm: true,
      });
      statusGuardHeld = false;
    } catch {
      // refused — good
    }
    check('status changes require confirmation and only offer the lifecycle (8/9)', statusGuardHeld);

    // ── 15–16. Audit records ─────────────────────────────────────────────────
    const auditRows = await odb
      .select({ action: people.auditLog.action, before: people.auditLog.before, after: people.auditLog.after })
      .from(people.auditLog)
      .where(eq(people.auditLog.schoolId, schoolAId));

    const actions = auditRows.map((r) => r.action);
    for (const expected of ['school.created', 'school.principal_created', 'school.suspended', 'school.reactivated']) {
      check(`audit records ${expected} (15)`, actions.includes(expected));
    }
    const auditJson = JSON.stringify(auditRows);
    check(
      'temporary password absent from every audit record (16)',
      !auditJson.includes(result.temporaryPassword) && !auditJson.includes('temporaryPassword":'),
    );

    // ── 20. The runtime never touches the owner credential ──────────────────
    // Static contract: no application module under platform/auth may reference
    // the owner/unpooled credential; the connection contract (test:config)
    // already proves the runtime resolves DATABASE_URL_APP only.
    const files = [
      'src/lib/platform/schools.ts',
      'src/lib/platform/session.ts',
      'src/lib/auth/change-password.ts',
      'src/lib/auth/credentials.ts',
      'src/lib/auth/session-store.ts',
    ];
    const offender = files.find((f) =>
      readFileSync(f, 'utf8').includes('DATABASE_URL_UNPOOLED'),
    );
    check('no owner DB credential in application runtime modules (20)', !offender, offender ?? '');

    // ── 19. Rerun safety: cleanup leaves no partial state for the next run ──
    await odb.delete(core.schools).where(
      inArray(core.schools.code, [CODE_A, CODE_B, CODE_ATOMIC, CODE_NEWLOGIN]),
    );
    const leftover = await odb
      .select({ id: people.users.id })
      .from(people.users)
      .where(eq(people.users.schoolId, schoolAId));
    check('fixture cleanup is complete and rerun-safe (19)', leftover.length === 0);
  } finally {
    await owner.end();
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All platform onboarding checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
