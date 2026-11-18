/**
 * WordPress password hashes verify in the SaaS. The fixture holds REAL hashes made by WordPress 6.8 itself
 * (wp_hash_password, password_hash, phpass, md5), each confirmed accepted by wp_check_password.
 *   npx tsx src/db/test-legacy-password.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Fx = { style: string; password: string; hash: string };
async function main() {
  const { verifyLegacyPassword, legacyStyleOf, isCarryableLegacyHash } = await import('@/lib/auth/legacy-password');
  const { hashPassword } = await import('@/lib/auth/password');
  const fx: Fx[] = JSON.parse(readFileSync(new URL('../lib/auth/fixtures/wordpress-hashes.json', import.meta.url), 'utf8'));
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  for (const style of ['wp-bcrypt', 'bcrypt', 'phpass', 'md5']) {
    await check(`${style}: the right password verifies for every real WordPress hash (${fx.filter((x) => x.style === style).length})`, async () => {
      const list = fx.filter((x) => x.style === style); assert.ok(list.length >= 3);
      for (const x of list) { assert.equal(legacyStyleOf(x.hash), style); assert.equal(await verifyLegacyPassword(x.hash, x.password), true, `${style} ${x.password}`); }
    });
    await check(`${style}: a wrong password is refused`, async () => {
      for (const x of fx.filter((y) => y.style === style)) {
        // Plain bcrypt reads only the first 72 bytes (PHP's password_verify does too), so for a longer password
        // the wrong guess must change an early character, not append one.
        assert.equal(await verifyLegacyPassword(x.hash, 'Z' + x.password.slice(1)), false);
        assert.equal(await verifyLegacyPassword(x.hash, ''), false);
      }
    });
  }
  await check('plain bcrypt ignores everything past byte 72, exactly like PHP (documented, not a bug)', async () => {
    const long = fx.find((x) => x.style === 'bcrypt' && x.password.length > 100)!;
    assert.equal(await verifyLegacyPassword(long.hash, long.password + 'tail'), true);
  });
  await check('a password never verifies against another person\'s hash', async () => {
    const [a, b] = [fx.find((x) => x.style === 'wp-bcrypt')!, fx.filter((x) => x.style === 'wp-bcrypt')[1]!];
    assert.notEqual(a.password, b.password); assert.equal(await verifyLegacyPassword(b.hash, a.password), false);
  });
  await check('non-ASCII and over-72-byte passwords work (WordPress pre-hashes, so no truncation)', async () => {
    const uni = fx.find((x) => x.style === 'wp-bcrypt' && /ñ/.test(x.password))!; assert.equal(await verifyLegacyPassword(uni.hash, uni.password), true);
    const long = fx.find((x) => x.style === 'wp-bcrypt' && x.password.length > 100)!;
    assert.equal(await verifyLegacyPassword(long.hash, long.password), true);
    assert.equal(await verifyLegacyPassword(long.hash, long.password.slice(0, 80)), false, 'a prefix of a long WordPress password must NOT verify');
  });
  await check('a password saved with surrounding spaces trimmed still signs in when typed with them', async () => {
    const x = fx.find((y) => y.style === 'phpass')!; assert.equal(await verifyLegacyPassword(x.hash, `  ${x.password}  `), true);
  });
  await check('Argon2id hashes and junk are not mistaken for WordPress hashes', async () => {
    const argon = await hashPassword('Sch00l!Pass');
    assert.equal(legacyStyleOf(argon), null); assert.equal(await verifyLegacyPassword(argon, 'Sch00l!Pass'), false);
    for (const junk of ['', 'x', '*', '*0', '$P$short', '$wp$2y$10$tooshort', 'not a hash', '$2y$10$' + 'a'.repeat(10)]) {
      assert.equal(legacyStyleOf(junk), null); assert.equal(await verifyLegacyPassword(junk, 'anything'), false);
    }
  });
  await check('the unusable markers WordPress uses ("*") can never be signed in with', async () => {
    assert.equal(await verifyLegacyPassword('*', '*'), false); assert.equal(await verifyLegacyPassword('*0', '*0'), false);
  });
  await check('only recognised WordPress styles may be carried into the database', () => {
    for (const x of fx) assert.equal(isCarryableLegacyHash(x.hash), true);
    for (const bad of [null, undefined, 42, '', 'plaintext-password', '*', '$argon2id$v=19$m=1,t=1,p=1$c2FsdA$aaaa']) assert.equal(isCarryableLegacyHash(bad), false);
  });
  console.log(`${count} legacy password checks passed.`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
