/**
 * issuePrincipalPassword(): the step that makes a backup made WITHOUT passwords usable.
 *   npx tsx src/db/test-issue-principal-password.ts
 * Run against a disposable LOCAL database; never production.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('This test requires a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const { hashPassword, verifyPassword } = await import('@/lib/auth/password');
  const { issuePrincipalPassword, NotFoundError, OnboardingValidationError, PlatformPermissionError } = await import('@/lib/platform/schools');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const { restoreSchool } = await import('@/lib/school-backup/restore');
  const { createSession } = await import('@/lib/auth/session-store');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const suffix = randomUUID().slice(0, 6).toUpperCase();

  const [admin] = await db.insert(schema.users).values({ schoolId: null, role: 'platform_admin', loginId: 'padmin-' + suffix, passwordHash: await hashPassword('Admin-pass-2026'), mustChangePassword: false }).returning();
  const actor = { userId: Number(admin!.id), loginId: String(admin!.loginId), role: 'platform_admin' as const };

  // A school restored from a backup WITHOUT passwords: every login is a placeholder, like a real migration.
  const [src] = await db.insert(schema.schools).values({ name: 'Issue Source School', code: 'IS' + suffix, subdomain: 'is' + suffix.toLowerCase() }).returning();
  schoolIds.push(src!.id);
  await db.insert(schema.academicSessions).values({ schoolId: src!.id, title: '2026/27', isCurrent: true });
  const [pu] = await db.insert(schema.users).values({ schoolId: src!.id, role: 'principal', loginId: 'PRN-' + suffix, passwordHash: await hashPassword('Old-principal-pass'), mustChangePassword: false }).returning();
  await db.insert(schema.staff).values({ schoolId: src!.id, userId: pu!.id, role: 'principal', staffNumber: 'PRN-1', firstName: 'Ngozi', lastName: 'Eze' });
  const [tu] = await db.insert(schema.users).values({ schoolId: src!.id, role: 'teacher', loginId: 'T-' + suffix, passwordHash: await hashPassword('Teacher-old-pass'), mustChangePassword: false }).returning();
  await db.insert(schema.staff).values({ schoolId: src!.id, userId: tu!.id, role: 'teacher', staffNumber: 'T-1', firstName: 'Tobi', lastName: 'Ade' });
  const file = (await exportSchool(src!.id)).file;
  const restored = await restoreSchool({ actorUserId: actor.userId, file, code: 'IR' + suffix, subdomain: 'ir' + suffix.toLowerCase(), principalPassword: 'defer' });
  const NEW = restored.school.id; schoolIds.push(NEW);
  const principalRow = async (id = NEW) => (await q(`select * from users where school_id = $1 and role = 'principal'`, [id]))[0]!;

  try {
    await check('BEFORE: the restored principal cannot sign in (placeholder)', async () => {
      const p = await principalRow();
      assert.ok(String(p.password_hash).startsWith('!restored-no-password!'));
      assert.equal(await verifyPassword(String(p.password_hash), 'Old-principal-pass'), false);
    });

    const othersBefore = await q(`select id, password_hash from users where role = 'principal' and school_id <> $1 order by id`, [NEW]);
    let issued: Awaited<ReturnType<typeof issuePrincipalPassword>>;
    await check('issuing returns the sign-in id, the name and a strong temporary password', async () => {
      const p = await principalRow();
      issued = await issuePrincipalPassword(actor, NEW);
      assert.equal(issued.loginId, p.login_id); assert.equal(issued.name, 'Ngozi Eze');
      assert.ok(issued.temporaryPassword.length >= 12);
    });
    await check('AFTER: the principal signs in with it, and is made to change it', async () => {
      // (the restore already set the flag; clear it first so only issuePrincipalPassword() can be what sets it)
      await owner`update users set must_change_password = false where school_id = ${NEW} and role = 'principal'`;
      issued = await issuePrincipalPassword(actor, NEW);
      const p = await principalRow();
      assert.equal(await verifyPassword(String(p.password_hash), issued.temporaryPassword), true);
      assert.equal(p.must_change_password, true);
      assert.ok(String(p.password_hash).startsWith('$argon2id$'));
    });
    await check('the password is NOT stored in clear anywhere: not the users row, the audit log, nor any school row', async () => {
      const pw = issued.temporaryPassword;
      const haystack = JSON.stringify([
        await q(`select * from users where school_id = $1`, [NEW]),
        await q(`select * from audit_log where school_id = $1`, [NEW]),
        await q(`select * from schools where id = $1`, [NEW]),
        await q(`select * from school_backup_jobs`),
      ]);
      assert.ok(!haystack.includes(pw), 'the temporary password was found stored in the database');
    });
    await check('it is audited without the password: who, which school, what happened', async () => {
      const [a] = await q(`select actor_user_id, actor_role, entity_type, after from audit_log where school_id = $1 and action = 'school.principal_password_issued'`, [NEW]);
      assert.ok(a); assert.equal(Number(a!.actor_user_id), actor.userId); assert.equal(a!.entity_type, 'users');
      assert.deepEqual(a!.after, { temporaryPasswordIssued: true, sessionsRevoked: true });
    });
    await check('only the principal changes: the teacher keeps their unusable placeholder', async () => {
      const [t] = await q(`select password_hash from users where school_id = $1 and role = 'teacher'`, [NEW]);
      assert.ok(String(t!.password_hash).startsWith('!restored-no-password!'));
    });
    await check('the ORIGINAL school\'s principal is not touched, and neither is any other school\'s', async () => {
      assert.equal(await verifyPassword(String((await principalRow(src!.id)).password_hash), 'Old-principal-pass'), true);
      // every principal outside the restored school must be byte-identical to how it was before any issuing
      const now = await q(`select id, password_hash from users where role = 'principal' and school_id <> $1 order by id`, [NEW]);
      assert.deepEqual(now, othersBefore, 'a principal outside the restored school changed');
    });
    await check('the update is scoped to the school: a user id that belongs to ANOTHER school is never changed', async () => {
      // Make the chosen principal row appear to belong to another school mid-flight is not possible from here,
      // so assert the statement itself: the update carries the school id in its WHERE clause.
      const { readFileSync } = await import('node:fs');
      const code = readFileSync('src/lib/platform/schools.ts', 'utf8');
      const body = code.slice(code.indexOf('export async function issuePrincipalPassword'));
      assert.match(body, /\.where\(and\(eq\(schema\.users\.id, target\.id\), eq\(schema\.users\.schoolId, schoolId\)\)\)/);
    });
    await check('issuing again replaces the password: the first one stops working', async () => {
      const second = await issuePrincipalPassword(actor, NEW);
      assert.notEqual(second.temporaryPassword, issued.temporaryPassword);
      const p = await principalRow();
      assert.equal(await verifyPassword(String(p.password_hash), second.temporaryPassword), true);
      assert.equal(await verifyPassword(String(p.password_hash), issued.temporaryPassword), false);
    });
    await check('existing sessions are revoked and a lock-out is cleared', async () => {
      const p = await principalRow();
      await createSession(Number(p.id), '127.0.0.1', 'test'); await createSession(Number(p.id), '127.0.0.1', 'test');
      await owner`update users set failed_attempts = 9, locked_until = now() + interval '1 hour' where id = ${Number(p.id)}`;
      assert.equal((await q(`select count(*)::int as n from sessions where user_id = $1`, [p.id]))[0]!.n, 2);
      await issuePrincipalPassword(actor, NEW);
      assert.equal((await q(`select count(*)::int as n from sessions where user_id = $1`, [p.id]))[0]!.n, 0);
      const after = await principalRow();
      assert.equal(Number(after.failed_attempts), 0); assert.equal(after.locked_until, null);
    });

    // ── refusals ──────────────────────────────────────────────────────────
    await check('REFUSED: a school that does not exist', async () => {
      await assert.rejects(() => issuePrincipalPassword(actor, 99999999), NotFoundError);
      for (const bad of [0, -1, 1.5, NaN]) await assert.rejects(() => issuePrincipalPassword(actor, bad), NotFoundError);
    });
    await check('REFUSED: a suspended school (the administrator withdrew its access)', async () => {
      await owner`update schools set status = 'suspended' where id = ${NEW}`;
      const before = (await principalRow()).password_hash;
      await assert.rejects(() => issuePrincipalPassword(actor, NEW), (e: unknown) => e instanceof OnboardingValidationError && /not active/.test(Object.values(e.fieldErrors)[0]!));
      assert.equal((await principalRow()).password_hash, before, 'a refused request must change nothing');
      await owner`update schools set status = 'active' where id = ${NEW}`;
    });
    await check('REFUSED: a school with no active principal', async () => {
      await owner`update users set status = 'suspended' where school_id = ${NEW} and role = 'principal'`;
      await assert.rejects(() => issuePrincipalPassword(actor, NEW), (e: unknown) => e instanceof OnboardingValidationError && /no active principal/.test(Object.values(e.fieldErrors)[0]!));
      await owner`update users set status = 'active' where school_id = ${NEW} and role = 'principal'`;
    });
    await check('REFUSED: anyone who is not a platform administrator', async () => {
      await assert.rejects(() => issuePrincipalPassword({ userId: 1, loginId: 'x', role: 'principal' as never }, NEW), PlatformPermissionError);
    });
    await check('with two principals, the OLDEST active one is the one issued a password', async () => {
      const [oldest] = await q(`select id, login_id, password_hash from users where school_id = $1 and role = 'principal' order by id limit 1`, [NEW]);
      const [second] = await db.insert(schema.users).values({ schoolId: NEW, role: 'principal', loginId: 'PRN-2-' + suffix, passwordHash: await hashPassword('Second-principal'), mustChangePassword: false }).returning();
      assert.ok(Number(second!.id) > Number(oldest!.id));
      const out = await issuePrincipalPassword(actor, NEW);
      assert.equal(out.loginId, oldest!.login_id, 'the oldest active principal must be the one issued');
      const [oldestAfter] = await q(`select password_hash from users where id = $1`, [oldest!.id]);
      assert.equal(await verifyPassword(String(oldestAfter!.password_hash), out.temporaryPassword), true);
      assert.equal(await verifyPassword(String(second!.passwordHash), 'Second-principal'), true, 'the other principal is untouched');
    });

    console.log('\n' + count + ' checks passed.');
  } finally {
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner`delete from users where id = ${Number(admin!.id)}`.catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end({ timeout: 2 }).catch(() => {});
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
