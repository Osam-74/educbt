/**
 * Old sign-in names (aliases). They add a new way to find an account, so every way it could go wrong is a test:
 * one school's alias must never open another school's account, a real name must always beat an alias, an ambiguous
 * alias must refuse, and an alias must never be a way around the lockout. Disposable LOCAL database only.
 *   npx tsx src/db/test-login-aliases.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

let pass = 0, fail = 0;
const check = async (name: string, fn: () => Promise<void>) => { try { await fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n   ', (e as Error).message.split('\n')[0]); } };

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  }
  const { authenticateCredentials } = await import('@/lib/auth/credentials');
  const { hashPassword } = await import('@/lib/auth/password');
  const { forSchool, schema } = await import('@/db');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const tag = randomUUID().slice(0, 6).toLowerCase();
  const mkSchool = async (n: string) => Number((await q<{ id: number }>("insert into schools (name, code, subdomain) values ($1, $2, $3) returning id", [`Alias ${n}`, `AL${n}-${tag}`.toUpperCase(), `al${n}${tag}`]))[0]!.id);
  const hash = await hashPassword('Correct-Horse-9');
  const mkUser = async (schoolId: number, login: string, role = 'teacher', status = 'active') =>
    Number((await q<{ id: number }>("insert into users (school_id, role, login_id, password_hash, status) values ($1, $2, $3, $4, $5) returning id", [schoolId, role, login, hash, status]))[0]!.id);
  const alias = (schoolId: number, userId: number, name: string) => q("insert into user_login_aliases (school_id, user_id, alias) values ($1, $2, $3)", [schoolId, userId, name]);
  const signIn = (loginId: string, schoolId: number, password = 'Correct-Horse-9') => authenticateCredentials({ loginId, password, schoolId });
  const A = await mkSchool('A'), B = await mkSchool('B');
  const ids: number[] = [A, B];

  try {
    const ann = await mkUser(A, 'ann/new'); await alias(A, ann, 'ANN.OLD');
    const bob = await mkUser(B, 'bob/new'); await alias(B, bob, 'BOB.OLD');

    await check('an old name signs in, in any letter case, and lands on the one account', async () => {
      for (const n of ['ANN.OLD', 'ann.old', 'Ann.Old']) assert.equal((await signIn(n, A)).user.loginId, 'ann/new');
    });
    await check('the new name still works', async () => { assert.equal((await signIn('ann/new', A)).user.loginId, 'ann/new'); });
    await check('an old name is refused with the wrong password', async () => { await assert.rejects(signIn('ANN.OLD', A, 'nope-nope-1')); });

    await check('SCHOOL ISOLATION: school A\'s old name does not exist in school B', async () => {
      await assert.rejects(signIn('ANN.OLD', B)); await assert.rejects(signIn('BOB.OLD', A));
    });
    await check('SCHOOL ISOLATION: the same old name in two schools finds each school\'s own person', async () => {
      const ann2 = await mkUser(B, 'ann2/new'); await alias(B, ann2, 'SHARED.OLD'); const ann3 = await mkUser(A, 'ann3/new'); await alias(A, ann3, 'SHARED.OLD');
      assert.equal((await signIn('SHARED.OLD', A)).user.loginId, 'ann3/new'); assert.equal((await signIn('SHARED.OLD', B)).user.loginId, 'ann2/new');
    });
    await check('SCHOOL ISOLATION: the platform door never resolves an alias (no school, no alias)', async () => {
      await assert.rejects(authenticateCredentials({ loginId: 'ANN.OLD', password: 'Correct-Horse-9', schoolId: null as never }));
    });
    await check('SCHOOL ISOLATION: row-level security hides one school\'s aliases from another', async () => {
      const seen = await forSchool(B, (tx) => tx.select({ id: schema.userLoginAliases.id }).from(schema.userLoginAliases).where(require('drizzle-orm').eq(schema.userLoginAliases.schoolId, A)));
      assert.equal(seen.length, 0);
      await assert.rejects(forSchool(B, (tx) => tx.insert(schema.userLoginAliases).values({ schoolId: A, userId: ann, alias: 'PLANTED' })), 'planting an alias in another school is refused');
    });

    await check('SCHOOL ISOLATION: an alias row in school B that points at a person in school A opens nothing (the person must be in the school signing in)', async () => {
      const zed = await mkUser(A, 'zed/new');
      // Built by the owner connection, bypassing row-level security, to model a corrupted or hand-edited row.
      await q("insert into user_login_aliases (school_id, user_id, alias) values ($1, $2, 'ZED.CROSS')", [B, zed]);
      await assert.rejects(signIn('ZED.CROSS', B), 'school B must not reach a person who belongs to school A');
      await assert.rejects(signIn('ZED.CROSS', A), 'and the alias is not valid in school A either, because it was filed under B');
    });
    await check('SCHOOL ISOLATION: an alias row filed under school A that points at a person in school B opens nothing', async () => {
      const yan = await mkUser(B, 'yan/new');
      await q("insert into user_login_aliases (school_id, user_id, alias) values ($1, $2, 'YAN.CROSS')", [A, yan]);
      await assert.rejects(signIn('YAN.CROSS', A), 'school A must not reach a person who belongs to school B');
    });
    await check('EACH LAYER ALONE: with row-level security out of the picture (owner connection), the explicit school checks still keep the schools apart', async () => {
      const { findUsersByAlias } = await import('@/lib/auth/credentials');
      const { drizzle } = await import('drizzle-orm/postgres-js');
      const ownerDb = drizzle(owner, { schema });          // the owner connection is NOT subject to row-level security
      const rowsA = await findUsersByAlias(ownerDb as never, A, 'ANN.OLD'); assert.equal(rowsA.length, 1);
      assert.equal((await findUsersByAlias(ownerDb as never, B, 'ANN.OLD')).length, 0, 'school B must not find school A\'s alias');
      assert.equal((await findUsersByAlias(ownerDb as never, B, 'ZED.CROSS')).length, 0, 'an alias filed under B pointing at a person of A finds nobody');
      assert.equal((await findUsersByAlias(ownerDb as never, A, 'YAN.CROSS')).length, 0, 'an alias filed under A pointing at a person of B finds nobody');
      // The ONE case only the "filed under this school" check can stop: the person IS in school A, but the alias is filed under B.
      assert.equal((await findUsersByAlias(ownerDb as never, A, 'ZED.CROSS')).length, 0, 'an alias filed under another school does not work in the person\'s own school');
      assert.equal((await findUsersByAlias(ownerDb as never, A, 'ann.old')).length, 1, 'and the right school still finds its own, in any case');
    });
    await check('A REAL NAME ALWAYS WINS: an alias equal to someone else\'s real sign-in name cannot take it over', async () => {
      const carol = await mkUser(A, 'carol/new'); const dave = await mkUser(A, 'dave/new');
      await alias(A, dave, 'carol/new');                       // dave's old name collides with carol's REAL name
      assert.equal((await signIn('carol/new', A)).user.loginId, 'carol/new', 'carol still gets carol');
      await assert.rejects(signIn('carol/new', A, 'x-x-x-x-x-1'));
      void carol;
    });
    await check('an alias is unique per school ignoring case (the database refuses a clash)', async () => {
      const e1 = await mkUser(A, 'eve/new'); const e2 = await mkUser(A, 'finn/new'); await alias(A, e1, 'DUP.NAME');
      await assert.rejects(alias(A, e2, 'dup.name'), /unique|duplicate/i);
    });
    await check('an inactive account is not found through an old name either', async () => {
      const g = await mkUser(A, 'gone/new', 'teacher', 'suspended'); await alias(A, g, 'GONE.OLD');
      await assert.rejects(signIn('GONE.OLD', A));
    });
    await check('an old name that looks like an email is not looked up as an alias (no probing aliases by email)', async () => {
      const h = await mkUser(A, 'hana/new'); await alias(A, h, 'hana@old.example');
      await assert.rejects(signIn('hana@old.example', A));
    });
    await check('deleting a person deletes their old names with them', async () => {
      const i = await mkUser(A, 'ivy/new'); await alias(A, i, 'IVY.OLD'); await q('delete from users where id = $1', [i]);
      const [n] = await q<{ n: string }>("select count(*)::int n from user_login_aliases where alias = 'IVY.OLD'"); assert.equal(Number(n!.n), 0);
    });
    await check('LOCKOUT: wrong guesses under an old name and the new name count against the SAME account', async () => {
      const j = await mkUser(A, 'jo/new'); await alias(A, j, 'JO.OLD');
      for (const g of ['JO.OLD', 'jo/new', 'JO.OLD', 'jo/new', 'JO.OLD']) await assert.rejects(signIn(g, A, 'wrong-wrong-1'));
      await assert.rejects(signIn('JO.OLD', A), /locked/i); await assert.rejects(signIn('jo/new', A), /locked/i);
    });
  } finally {
    for (const id of ids) await q('delete from schools where id = $1', [id]).catch(() => {});
    await owner.end();
  }
  console.log(`\n${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
