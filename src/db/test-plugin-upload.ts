/**
 * The whole chain, end to end, on a file the PLUGIN'S OWN EXPORTER wrote:
 *   real .gz bytes -> the same door every upload uses (prepareUploadedFile) -> restoreSchool -> a person signs in.
 * Disposable LOCAL database only.
 *   npx tsx src/db/test-plugin-upload.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

let pass = 0, fail = 0;
const check = async (name: string, fn: () => Promise<void>) => { try { await fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n   ', (e as Error).message.split('\n')[0]); } };

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  }
  const { prepareUploadedFile } = await import('@/lib/school-backup/prepare-upload');
  const { restoreSchool } = await import('@/lib/school-backup/restore');
  const { authenticateCredentials } = await import('@/lib/auth/credentials');
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const fx = (n: string) => readFileSync(new URL(`../lib/school-backup/fixtures/${n}`, import.meta.url));
  const known: Record<string, string> = JSON.parse(fx('plugin-demo-passwords.json').toString());
  const [admin] = await q<{ id: number }>("select id from users where role = 'platform_admin' order by id limit 1");
  assert.ok(admin, 'a platform admin exists in the test database');
  const suffix = randomUUID().slice(0, 6).toUpperCase(); const schoolIds: number[] = [];

  try {
    // ── WITHOUT passwords: the school arrives complete, nobody can sign in with an old password, nothing leaks
    const a = prepareUploadedFile(fx('plugin-real-export.gz'));
    await check('a real plugin file is recognised and translated by the upload door', async () => { assert.equal(a.source, 'plugin'); assert.ok(a.report!.translated.students === 7); });
    const r1 = await restoreSchool({ actorUserId: admin.id, file: a.file, code: 'UP1-' + suffix, subdomain: 'up1' + suffix.toLowerCase(), principalPassword: 'defer' });
    schoolIds.push(r1.school.id);
    await check('the school is restored with its people, classes and results', async () => {
      const n = async (t: string) => Number((await q<{ n: string }>(`select count(*)::int n from ${t} where school_id = $1`, [r1.school.id]))[0]!.n);
      assert.equal(await n('students'), 7); assert.equal(await n('staff'), 8); assert.equal(await n('assessment_scores'), 187);
      assert.equal(await n('bank_questions'), 33); assert.equal(await n('legacy_exam_attempts'), 4); assert.equal(await n('legacy_attempt_answers'), 40);
    });
    await check('no password crossed (the file said none), so no old password signs in', async () => {
      const [h] = await q<{ n: string }>("select count(*)::int n from users where school_id = $1 and (password_hash like '$wp$%' or password_hash like '$P$%' or password_hash like '$2y$%')", [r1.school.id]);
      assert.equal(Number(h!.n), 0);
      for (const [login, pw] of [['DSS001.STF.007', known['9']!], ['DEMO2024001', known['2']!], ['DSS001.STF.008', known['10']!]] as const) {
        await assert.rejects(authenticateCredentials({ loginId: login, password: pw, schoolId: r1.school.id }), `${login} must not sign in without a carried password`);
      }
    });

    // ── WITH passwords: the three people sign in with the passwords they already had, in all three hash styles
    const b = prepareUploadedFile(fx('plugin-real-export-with-passwords.gz'));
    const r2 = await restoreSchool({ actorUserId: admin.id, file: b.file, code: 'UP2-' + suffix, subdomain: 'up2' + suffix.toLowerCase(), principalPassword: 'defer' });
    schoolIds.push(r2.school.id);
    // Every name a person could have typed on the plugin, and the name the platform gives them now.
    const people = [
      { names: ['DEMO2024001', 'demo2024001', 'DEMO/2024/001', 'adm001', 'ADM001'], pw: known['2']!, style: 'wp-sha384 over bcrypt', canonical: 'adm001', role: 'student' },
      { names: ['DSS001.STF.007', 'dss001.stf.007', 'dss001/stf/007', 'DSS001/STF/007'], pw: known['9']!, style: 'plain bcrypt', canonical: 'dss001/stf/007', role: 'principal' },
      { names: ['DSS001.STF.008', 'dss001/stf/008'], pw: known['10']!, style: 'phpass', canonical: 'dss001/stf/008', role: 'teacher' },
    ];
    for (const p of people) {
      for (const name of p.names) {
        await check(`${p.role} signs in as "${name}" with the password they ALREADY had (${p.style}), from a file the plugin really wrote`, async () => {
          const res = await authenticateCredentials({ loginId: name, password: p.pw, schoolId: r2.school.id });
          assert.equal(res.user.loginId, p.canonical, 'lands on the one account, whichever name was typed');
        });
      }
      await check(`${p.canonical}: the first good sign-in silently upgraded the old hash to the platform's own`, async () => {
        const [row] = await q<{ password_hash: string }>('select password_hash from users where school_id = $1 and login_id = $2', [r2.school.id, p.canonical]);
        assert.ok(row!.password_hash.startsWith('$argon2id$'));
      });
      await check(`${p.canonical} is turned away with a wrong password, under every old name`, async () => {
        // Two wrong tries only (below the account lockout); the good sign-in right after resets the counter.
        for (const name of [p.names[0]!, p.canonical]) await assert.rejects(authenticateCredentials({ loginId: name, password: p.pw + 'x', schoolId: r2.school.id }));
        assert.equal((await authenticateCredentials({ loginId: p.names[0]!, password: p.pw, schoolId: r2.school.id })).user.loginId, p.canonical);
      });
      await check(`${p.canonical} still signs in after the upgrade, by old and new name`, async () => {
        for (const name of [p.names[0]!, p.canonical]) assert.equal((await authenticateCredentials({ loginId: name, password: p.pw, schoolId: r2.school.id })).user.loginId, p.canonical);
      });
    }
    await check('wrong guesses under DIFFERENT old names pool onto the one account and lock it (an attacker cannot rotate names to dodge the lockout)', async () => {
      const victim = people[2]!; const guesses = [victim.names[0]!, victim.names[1]!, victim.canonical, victim.names[0]!, victim.names[1]!];
      for (const g of guesses) await assert.rejects(authenticateCredentials({ loginId: g, password: 'Wrong-Guess-1', schoolId: r2.school.id }));
      const [u] = await q<{ failed_attempts: number; locked: boolean }>("select failed_attempts, (locked_until is not null and locked_until > now()) as locked from users where school_id = $1 and login_id = $2", [r2.school.id, victim.canonical]);
      assert.equal(Number(u!.failed_attempts), 5); assert.equal(u!.locked, true, 'five wrong guesses across two old names and the new one locked the single account');
      await assert.rejects(authenticateCredentials({ loginId: victim.names[0]!, password: victim.pw, schoolId: r2.school.id }), /locked/i);
      await q("update users set failed_attempts = 0, locked_until = null where school_id = $1", [r2.school.id]);
    });
    await check('nobody is told their password changed: no forced change, only the optional prompt', async () => {
      const [u] = await q<{ must_change_password: boolean }>("select must_change_password from users where school_id = $1 and login_id = 'dss001/stf/007'", [r2.school.id]);
      assert.equal(u!.must_change_password, false);
    });
    await check('the administrator account of the plugin site did NOT cross into the school', async () => {
      const [x] = await q<{ n: string }>("select count(*)::int n from users where school_id = $1 and lower(login_id) = 'admin'", [r2.school.id]);
      assert.equal(Number(x!.n), 0);
    });

    // ── the two restores are separate schools and never touch each other
    await check('the two uploads are two separate schools; neither overwrote the other', async () => {
      assert.notEqual(r1.school.id, r2.school.id);
      const [x] = await q<{ n: string }>('select count(distinct school_id)::int n from students where school_id = any($1::bigint[])', [schoolIds]); assert.equal(Number(x!.n), 2);
    });
  } finally {
    for (const id of schoolIds) await q('delete from schools where id = $1', [id]).catch(() => {});
    await owner.end();
  }
  console.log(`\n${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
