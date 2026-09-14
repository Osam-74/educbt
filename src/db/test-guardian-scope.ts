/**
 * GUARDIAN → CHILD AUTHORIZATION ISOLATION (Phase 6 follow-up)
 *
 * Closes the one P1 identified but not verified in docs/security-audit.md:
 * a dedicated adversarial test for the guardian↔child boundary, on top of the
 * broader RLS tenant-isolation proof in docs/rls-audit.md.
 *
 * Exercises the real authorization gate, `reportAudience()` in
 * `src/lib/results/report-access.ts`, plus the write-path guard in
 * `linkGuardian()` (src/lib/people/students.ts), against a real database —
 * not a mock. Proves, with actual data across two real schools:
 *
 *   1. Guardian A cannot access another guardian's child (same school, no link).
 *   2. Being a registered guardian AT a school is not itself sufficient — the
 *      specific guardian→student link is required, not mere school membership.
 *   3. A cross-school relationship is rejected, both at read time
 *      (`reportAudience` under the guardian's own school scope can never
 *      resolve a foreign school's student) and at write time (`linkGuardian`
 *      refuses to create a link to a student who isn't in the actor's school).
 *   4. A revoked/inactive guardian link (`can_view_results = false`) cannot
 *      view protected child results, even though the relationship row exists.
 *
 * Uses only a disposable localhost *_ca_test database.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import type { Actor } from '@/lib/session';

async function main() {
  for (const key of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL_APP']) {
    const url = new URL(process.env[key] ?? '');
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_ca_test'), 'Disposable local database required');
  }

  const { schema } = await import('@/db');
  const { forSchool, client: appSingleton } = await import('@/db');
  const { reportAudience } = await import('@/lib/results/report-access');
  const { linkGuardian, StudentError } = await import('@/lib/people/students');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  // ── Fixture: two real schools ───────────────────────────────────────────
  const [schoolA] = await db.insert(schema.schools).values({ name: 'Guardian Scope School A', code: 'GS-A-' + randomUUID() }).returning();
  const [schoolB] = await db.insert(schema.schools).values({ name: 'Guardian Scope School B', code: 'GS-B-' + randomUUID() }).returning();
  const schoolAId = schoolA!.id, schoolBId = schoolB!.id;

  const [sessionA] = await db.insert(schema.academicSessions).values({ schoolId: schoolAId, title: '2026/2027' }).returning();
  const [levelA] = await db.insert(schema.classLevels).values({ schoolId: schoolAId, name: 'JSS1', levelOrder: 1 }).returning();
  const [classA] = await db.insert(schema.classes).values({ schoolId: schoolAId, levelId: levelA!.id, arm: 'A', displayName: 'JSS1 A' }).returning();

  // School A users: two parent-role accounts, one principal (office role, to exercise linkGuardian).
  const [uPrincipalA, uParentGA1, uParentGA2] = await db.insert(schema.users).values([
    { schoolId: schoolAId, role: 'principal', loginId: 'principalA' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false },
    { schoolId: schoolAId, role: 'parent', loginId: 'ga1' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false },
    { schoolId: schoolAId, role: 'parent', loginId: 'ga2' + randomUUID().slice(0, 6), passwordHash: 'unused', mustChangePassword: false },
  ]).returning();
  const actorPrincipalA: Actor = { schoolId: schoolAId, userId: uPrincipalA!.id, role: 'principal', loginId: uPrincipalA!.loginId, staffId: null, studentId: null };
  const actorGA1: Actor = { schoolId: schoolAId, userId: uParentGA1!.id, role: 'parent', loginId: uParentGA1!.loginId, staffId: null, studentId: null };

  // School A students: SA1 (GA1's real child), SA2 (GA2's child — NOT GA1's), SA3 (GA1's child, but view revoked).
  const [sa1, sa2, sa3] = await db.insert(schema.students).values([
    { schoolId: schoolAId, admissionNumber: 'SA1-' + randomUUID().slice(0, 6), firstName: 'Amaka', lastName: 'One', status: 'active' as any },
    { schoolId: schoolAId, admissionNumber: 'SA2-' + randomUUID().slice(0, 6), firstName: 'Chuka', lastName: 'Two', status: 'active' as any },
    { schoolId: schoolAId, admissionNumber: 'SA3-' + randomUUID().slice(0, 6), firstName: 'Zara', lastName: 'Three', status: 'active' as any },
  ]).returning();
  for (const s of [sa1!, sa2!, sa3!]) {
    await db.insert(schema.enrollments).values({ schoolId: schoolAId, studentId: s.id, sessionId: sessionA!.id, classId: classA!.id });
  }

  const [guardianGA1] = await db.insert(schema.guardians).values({ schoolId: schoolAId, userId: uParentGA1!.id, fullName: 'Guardian One', email: 'ga1' + randomUUID().slice(0, 6) + '@example.test', inviteStatus: 'accepted' }).returning();
  const [guardianGA2] = await db.insert(schema.guardians).values({ schoolId: schoolAId, userId: uParentGA2!.id, fullName: 'Guardian Two', email: 'ga2' + randomUUID().slice(0, 6) + '@example.test', inviteStatus: 'accepted' }).returning();

  // GA1 <-> SA1 (active, can view). GA1 <-> SA3 (active link, but view revoked).
  await db.insert(schema.guardianStudent).values([
    { schoolId: schoolAId, guardianId: guardianGA1!.id, studentId: sa1!.id, relationship: 'mother', canViewResults: true },
    { schoolId: schoolAId, guardianId: guardianGA1!.id, studentId: sa3!.id, relationship: 'mother', canViewResults: false },
  ]);
  // GA2 <-> SA2 — a DIFFERENT guardian's child, so GA1 has no relationship to SA2 at all.
  await db.insert(schema.guardianStudent).values({ schoolId: schoolAId, guardianId: guardianGA2!.id, studentId: sa2!.id, relationship: 'father', canViewResults: true });

  // ── Fixture: School B, a real student, to prove cross-school rejection ──
  const [sessionB] = await db.insert(schema.academicSessions).values({ schoolId: schoolBId, title: '2026/2027' }).returning();
  const [levelB] = await db.insert(schema.classLevels).values({ schoolId: schoolBId, name: 'JSS1', levelOrder: 1 }).returning();
  const [classB] = await db.insert(schema.classes).values({ schoolId: schoolBId, levelId: levelB!.id, arm: 'A', displayName: 'JSS1 A' }).returning();
  const [sb1] = await db.insert(schema.students).values({ schoolId: schoolBId, admissionNumber: 'SB1-' + randomUUID().slice(0, 6), firstName: 'Femi', lastName: 'Other', status: 'active' as any }).returning();
  await db.insert(schema.enrollments).values({ schoolId: schoolBId, studentId: sb1!.id, sessionId: sessionB!.id, classId: classB!.id });

  try {
    console.log('\n— positive control —');
    await check('a guardian CAN see the results audience for their own linked, active child', async () => {
      const audience = await forSchool(schoolAId, (t) => reportAudience(t, actorGA1, sa1!.id, sessionA!.id));
      assert.equal(audience, 'family');
    });

    console.log('\n— 1. another guardian\'s child (same school, no link) —');
    await check('a guardian CANNOT access a child linked only to a different guardian', async () => {
      const audience = await forSchool(schoolAId, (t) => reportAudience(t, actorGA1, sa2!.id, sessionA!.id));
      assert.equal(audience, null);
    });

    console.log('\n— 2. same-school relationship alone is insufficient —');
    await check('being a registered parent-role user in the school does not itself grant access — the specific link is required', async () => {
      // actorGA1 is a real, active parent account in school A, yet is denied
      // for sa2 above precisely because school membership is not the gate —
      // the guardian_student link row is. Re-assert directly against a
      // student with NO guardian_student row referencing this guardian at all.
      const audience = await forSchool(schoolAId, (t) => reportAudience(t, actorGA1, sa2!.id, sessionA!.id));
      assert.equal(audience, null, 'same-school membership must not substitute for a real guardian_student link');
    });

    console.log('\n— 3. cross-school relationship is rejected —');
    await check('a guardian in School A cannot resolve a real student who belongs to School B (read path)', async () => {
      const audience = await forSchool(schoolAId, (t) => reportAudience(t, actorGA1, sb1!.id, sessionA!.id));
      assert.equal(audience, null);
    });
    await check('the office cannot even CREATE a guardian link to a student in another school (write path)', async () => {
      await assert.rejects(
        linkGuardian(actorPrincipalA, sb1!.id, { fullName: 'Cross School Guardian', email: 'cross' + randomUUID().slice(0, 6) + '@example.test' }),
        (err: unknown) => err instanceof StudentError && /could not be found/i.test((err as Error).message),
        'linking across schools must fail closed, not silently succeed',
      );
    });

    console.log('\n— 4. revoked/inactive link cannot view protected results —');
    await check('a guardian whose link has can_view_results=false is denied, even though the relationship row exists', async () => {
      const audience = await forSchool(schoolAId, (t) => reportAudience(t, actorGA1, sa3!.id, sessionA!.id));
      assert.equal(audience, null);
    });
    await check('re-enabling can_view_results restores access — proves the gate is the flag, not a fixture mistake', async () => {
      await db.update(schema.guardianStudent).set({ canViewResults: true })
        .where(eq(schema.guardianStudent.studentId, sa3!.id));
      const audience = await forSchool(schoolAId, (t) => reportAudience(t, actorGA1, sa3!.id, sessionA!.id));
      assert.equal(audience, 'family');
    });

    console.log('\nGUARDIAN SCOPE OK: ' + count + ' checks passed. Guardian access is limited to the exact linked, active, same-school child.');
  } finally {
    await db.delete(schema.schools).where(eq(schema.schools.id, schoolAId));
    await db.delete(schema.schools).where(eq(schema.schools.id, schoolBId));
    // The '@/db' module singleton stays connected after forSchool calls; close
    // it so a passing run actually exits (same CI-hang fix as promotion/roles).
    await appSingleton.end().catch(() => {});
    await owner.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
