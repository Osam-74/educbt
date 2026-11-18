/**
 * School backup WITH PASSWORDS: the opt-in that lets every user keep the password they already have.
 *   npx tsx src/db/test-school-backup-passwords.ts
 * Run against a disposable LOCAL database; never production.
 *
 * What this protects: (1) the default file carries no credential at all; (2) the opt-in keeps ONLY
 * genuine Argon2id hashes, so a tampered file cannot smuggle in something weaker; (3) people really can
 * sign in with their OLD password afterwards; (4) two-factor secrets, lock-outs and invite links are
 * never carried, whatever the mode.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Backup password tests require a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const { hashPassword, verifyPassword } = await import('@/lib/auth/password');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const { restoreSchool } = await import('@/lib/school-backup/restore');
  const { decode, encode, buildDocument } = await import('@/lib/school-backup/format');
  const { ARGON2ID_HASH } = await import('@/lib/school-backup/registry');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const suffix = randomUUID().slice(0, 6).toUpperCase();

  // Three people with three DIFFERENT real passwords, so "kept their own" cannot pass by accident.
  const PW = { principal: 'Principal-pass-1', teacher: 'Teacher-pass-22', student: 'Student-pass-333' };
  const hashes = { principal: await hashPassword(PW.principal), teacher: await hashPassword(PW.teacher), student: await hashPassword(PW.student) };
  const [admin] = await db.insert(schema.users).values({ schoolId: null, role: 'platform_admin', loginId: 'padmin-' + suffix, passwordHash: hashes.principal, mustChangePassword: false }).returning();
  const [src] = await db.insert(schema.schools).values({ name: 'Passwords Source School', code: 'PW' + suffix, subdomain: 'pw' + suffix.toLowerCase() }).returning();
  const sourceId = src!.id; schoolIds.push(sourceId);
  const [pu] = await db.insert(schema.users).values({ schoolId: sourceId, role: 'principal', loginId: 'PRN-' + suffix, passwordHash: hashes.principal, mustChangePassword: false }).returning();
  const [tu] = await db.insert(schema.users).values({ schoolId: sourceId, role: 'teacher', loginId: 'T-' + suffix, passwordHash: hashes.teacher, mustChangePassword: true, totpSecret: 'TOTPSECRET' + suffix, totpEnabled: true, failedAttempts: 4, lockedUntil: new Date(Date.now() + 3600_000) }).returning();
  const [su] = await db.insert(schema.users).values({ schoolId: sourceId, role: 'student', loginId: 'S-' + suffix, passwordHash: hashes.student, mustChangePassword: false }).returning();
  await db.insert(schema.staff).values([
    { schoolId: sourceId, userId: pu!.id, role: 'principal', staffNumber: 'PRN-1', firstName: 'Pat', lastName: 'Head' },
    { schoolId: sourceId, userId: tu!.id, role: 'teacher', staffNumber: 'T-1', firstName: 'Tim', lastName: 'Teach' },
  ]);
  await db.insert(schema.students).values({ schoolId: sourceId, userId: su!.id, admissionNumber: 'ADM/1', firstName: 'Sam', lastName: 'Pupil' });
  const restored = async (file: Buffer, code: string, extra: Record<string, unknown> = {}) => {
    const r = await restoreSchool({ actorUserId: Number(admin!.id), file, code, subdomain: code.toLowerCase(), ...extra });
    schoolIds.push(r.school.id); return r;
  };
  const userRow = async (schoolId: number, role: string) => (await q(`select * from users where school_id = $1 and role = $2`, [schoolId, role]))[0]!;

  try {
    // ── the default ───────────────────────────────────────────────────────
    const safe = await exportSchool(sourceId);
    await check('DEFAULT: the file carries NO credentials and says so', () => {
      assert.equal(safe.credentials, 'none');
      const doc = decode(safe.file);
      assert.equal(doc.credentials, 'none');
      for (const u of doc.tables.users!) assert.ok(!('password_hash' in u), 'no password hash may be in the default file');
      const text = JSON.stringify(doc);
      for (const h of Object.values(hashes)) assert.ok(!text.includes(h), 'a real hash appears in the default file');
      assert.ok(!/WITH-PASSWORDS/.test(safe.fileName));
    });
    await check('DEFAULT: after a restore, NOBODY can sign in with their old password', async () => {
      const r = await restored(safe.file, 'D' + suffix);
      for (const role of ['teacher', 'student'] as const) {
        const u = await userRow(r.school.id, role);
        assert.equal(await verifyPassword(String(u.password_hash), PW[role]), false, role + ' must not keep their old password');
      }
    });

    // ── the opt-in ────────────────────────────────────────────────────────
    const withPw = await exportSchool(sourceId, { includePasswords: true });
    await check('OPT-IN: the file declares it, and its NAME warns that it is sensitive', () => {
      assert.equal(withPw.credentials, 'password-hashes');
      assert.equal(decode(withPw.file).credentials, 'password-hashes');
      assert.match(withPw.fileName, /-WITH-PASSWORDS\.educbt-school\.gz$/);
    });
    await check('OPT-IN: only Argon2id hashes are in the file; two-factor secrets and lock-outs still are not', () => {
      const doc = decode(withPw.file);
      const users = doc.tables.users!;
      assert.equal(users.length, 3);
      for (const u of users) {
        assert.match(String(u.password_hash), ARGON2ID_HASH);
        assert.ok(!('totp_secret' in u) && !('totp_enabled' in u) && !('failed_attempts' in u) && !('locked_until' in u), 'only password material may be added');
      }
      assert.ok(!JSON.stringify(doc).includes('TOTPSECRET'));
    });
    await check('OPT-IN: every user can sign in with the password they ALREADY had', async () => {
      const r = await restored(withPw.file, 'P' + suffix);
      assert.equal(r.credentials, 'password-hashes');
      for (const role of ['principal', 'teacher', 'student'] as const) {
        const u = await userRow(r.school.id, role);
        assert.equal(await verifyPassword(String(u.password_hash), PW[role]), true, role + ' must keep their own password');
        assert.equal(await verifyPassword(String(u.password_hash), 'Wrong-password-9'), false);
      }
    });
    await check('OPT-IN: NO temporary password is issued, because the principal already has one', async () => {
      const r = await restored(withPw.file, 'Q' + suffix);
      assert.equal(r.temporaryPassword, null);
    });
    await check('OPT-IN: each user keeps their own "must change password" flag', async () => {
      const r = await restored(withPw.file, 'F' + suffix);
      assert.equal((await userRow(r.school.id, 'teacher')).must_change_password, true);
      assert.equal((await userRow(r.school.id, 'student')).must_change_password, false);
    });
    await check('OPT-IN: two-factor, lock-outs and last login are STILL reset', async () => {
      const r = await restored(withPw.file, 'T' + suffix);
      const t = await userRow(r.school.id, 'teacher');
      assert.equal(t.totp_secret, null); assert.equal(t.totp_enabled, false);
      assert.equal(Number(t.failed_attempts), 0); assert.equal(t.locked_until, null); assert.equal(t.last_login_at, null);
    });
    await check('OPT-IN: the restored school is a separate copy: changing a password there leaves the original alone', async () => {
      const r = await restored(withPw.file, 'S' + suffix);
      const newHash = await hashPassword('Brand-new-pass-77');
      await owner`update users set password_hash = ${newHash} where school_id = ${r.school.id} and role = 'student'`;
      const orig = await userRow(sourceId, 'student');
      assert.equal(await verifyPassword(String(orig.password_hash), PW.student), true);
    });

    // ── a tampered file must not be able to smuggle a weak credential in ──
    const tamper = async (mutate: (users: Array<Record<string, unknown>>) => void, code: string) => {
      const doc = decode(withPw.file);
      const users = structuredClone(doc.tables.users!); mutate(users);
      const forged = buildDocument({ createdAt: doc.createdAt, app: doc.app, credentials: doc.credentials, school: doc.school, uploads: doc.uploads, tables: { ...doc.tables, users } });
      return restored(encode(forged), code);
    };
    await check('TAMPER: a plaintext "hash" is never accepted; that user gets an unusable placeholder', async () => {
      const r = await tamper((u) => { u.find((x) => x.role === 'student')!.password_hash = 'letmein123'; }, 'X1' + suffix);
      const s = await userRow(r.school.id, 'student');
      assert.ok(String(s.password_hash).startsWith('!restored-no-password!'));
      assert.equal(await verifyPassword(String(s.password_hash), 'letmein123'), false);
    });
    await check('TAMPER: an md5, empty or non-string value is never accepted', async () => {
      for (const [i, bad] of (['5f4dcc3b5aa765d61d8327deb882cf99', '', null, 12345, { $argon2id: 1 }] as unknown[]).entries()) {
        const r = await tamper((u) => { u.find((x) => x.role === 'teacher')!.password_hash = bad; }, `X2${i}` + suffix);
        assert.ok(String((await userRow(r.school.id, 'teacher')).password_hash).startsWith('!restored-no-password!'), 'accepted: ' + JSON.stringify(bad));
      }
    });
    await check('TAMPER: a lookalike that is not strictly an Argon2id string is refused', async () => {
      for (const [i, bad] of ([hashes.student + ' ', ' ' + hashes.student, hashes.student + '\n', '$argon2i$v=19$m=19456,t=2,p=1$YWFhYWFhYWE$YWFhYWFhYWFhYWFhYWFhYQ', '$argon2id$v=19$m=19456,t=2,p=1$bad$'] as string[]).entries()) {
        const r = await tamper((u) => { u.find((x) => x.role === 'student')!.password_hash = bad; }, `X3${i}` + suffix);
        assert.ok(String((await userRow(r.school.id, 'student')).password_hash).startsWith('!restored-no-password!'), 'accepted: ' + JSON.stringify(bad));
      }
    });
    await check('TAMPER: a file that does NOT declare password hashes ignores any hash planted in it', async () => {
      const doc = decode(safe.file);
      const users = structuredClone(doc.tables.users!);
      users.find((x) => x.role === 'student')!.password_hash = hashes.student; // a real hash, but the file says "none"
      const forged = buildDocument({ createdAt: doc.createdAt, app: doc.app, credentials: 'none', school: doc.school, uploads: doc.uploads, tables: { ...doc.tables, users } });
      const r = await restored(encode(forged), 'X4' + suffix);
      assert.ok(String((await userRow(r.school.id, 'student')).password_hash).startsWith('!restored-no-password!'));
    });
    await check('an old file with no credentials field is treated as carrying none', async () => {
      const { gunzipSync, gzipSync } = await import('node:zlib');
      const raw = JSON.parse(gunzipSync(safe.file).toString('utf8')) as Record<string, unknown>;
      delete raw.credentials;
      // (the checksum covered the field, so recompute it exactly as a pre-field exporter would have)
      const { checksum: _drop, ...body } = raw; void _drop;
      const { checksumOf } = await import('@/lib/school-backup/format');
      const legacy = gzipSync(Buffer.from(JSON.stringify({ ...body, checksum: checksumOf(body as never) })));
      assert.equal(decode(legacy).credentials, 'none');
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
