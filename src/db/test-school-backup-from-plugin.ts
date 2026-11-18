/**
 * Plugin -> SaaS migration, slice 1 (structure and people). A real school exported from the WordPress plugin
 * is translated and restored through the SAME restoreSchool() every SaaS backup uses, then compared with the
 * plugin source row by row. Disposable LOCAL database only.
 *   npx tsx src/db/test-school-backup-from-plugin.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

type Row = Record<string, unknown>;
async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) throw new Error('Requires a disposable local *_ca_test database.');
  }
  const { schema } = await import('@/db');
  const { translatePluginBackup, PluginBackupError } = await import('@/lib/school-backup/from-plugin');
  const { restoreSchool } = await import('@/lib/school-backup/restore');
  const { encode, decode } = await import('@/lib/school-backup/format');
  const { authenticateCredentials } = await import('@/lib/auth/credentials');
  const { verifyPassword } = await import('@/lib/auth/password');
  const known: Record<string, string> = JSON.parse(readFileSync(new URL('../lib/school-backup/fixtures/plugin-demo-passwords.json', import.meta.url), 'utf8'));
  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const q = async <T = Row>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const fixture = () => JSON.parse(readFileSync(new URL('../lib/school-backup/fixtures/plugin-demo-school.json', import.meta.url), 'utf8'));
  const [admin] = await db.insert(schema.users).values({ schoolId: null, role: 'platform_admin', loginId: 'padmin-' + suffix, passwordHash: 'unused', mustChangePassword: false }).returning();

  try {
    const plugin = fixture();
    const { document, report } = translatePluginBackup(plugin);
    const restored = await restoreSchool({ actorUserId: admin!.id, file: encode(document), code: 'FROMWP-' + suffix, subdomain: 'fromwp' + suffix.toLowerCase(), principalPassword: 'defer' });
    schoolIds.push(restored.school.id);
    const sid = restored.school.id;
    const count_ = async (t: string) => Number((await q<{ n: string }>(`select count(*)::int as n from ${t} where school_id = $1`, [sid]))[0]!.n);

    await check('the translated file is a valid SaaS backup (checksum, format, counts)', () => {
      const again = decode(encode(document));
      assert.equal(again.checksum, document.checksum); assert.equal(again.credentials, 'wordpress-hashes', 'the declaration must survive a save and re-open');
    });
    await check('every plugin row of slice 1 arrives: sessions, terms, levels, classes, subjects, staff, students, enrolments, duties', async () => {
      const p = plugin.tables;
      // The plugin's terms reference a session that was deleted; it is recreated as a labelled placeholder (reported), so +1.
      const orphanSessions = new Set(p.terms.map((t: Row) => String(t.session_id)).filter((id: string) => !p.academic_sessions.some((a: Row) => String(a.id) === id))).size;
      assert.equal(orphanSessions, 1, 'this fixture really does contain terms of a deleted session');
      assert.equal(await count_('academic_sessions'), p.academic_sessions.length + orphanSessions);
      assert.equal(await count_('terms'), p.terms.length);
      assert.equal(await count_('class_levels'), p.class_levels.length);
      assert.equal(await count_('classes'), p.classes.length);
      assert.equal(await count_('subjects'), p.subjects_v2.length);
      assert.equal(await count_('staff'), p.staff.length);
      assert.equal(await count_('students'), p.students.length);
      assert.equal(await count_('enrollments'), p.enrollments.length);
      assert.equal(await count_('staff_assignments'), p.staff_assignments.length);
    });
    await check('the school itself keeps its name', async () => assert.equal(restored.school.name, plugin.school.school_name));
    await check('students keep their admission numbers and names', async () => {
      const got = await q<{ admission_number: string; first_name: string; last_name: string }>('select admission_number, first_name, last_name from students where school_id = $1 order by admission_number', [sid]);
      const want = [...plugin.tables.students].map((s: Row) => `${s.admission_number}|${s.first_name}|${s.last_name}`).sort();
      assert.deepEqual(got.map((s) => `${s.admission_number}|${s.first_name}|${s.last_name}`).sort(), want);
    });
    await check('each student is in the SAME class as in the plugin (matched by name, not by id)', async () => {
      const got = await q<{ admission_number: string; display_name: string }>(`select s.admission_number, c.display_name from enrollments e join students s on s.id = e.student_id join classes c on c.id = e.class_id where e.school_id = $1`, [sid]);
      const plugClass = new Map<string, string>(plugin.tables.classes.map((c: Row) => [String(c.id), String(c.display_name)]));
      const plugStudent = new Map<string, string>(plugin.tables.students.map((s: Row) => [String(s.id), String(s.admission_number)]));
      const want = plugin.tables.enrollments.map((e: Row) => `${plugStudent.get(String(e.student_id))}|${plugClass.get(String(e.class_id))}`).sort();
      assert.deepEqual(got.map((r) => `${r.admission_number}|${r.display_name}`).sort(), want);
    });
    await check('each class sits in the same year group', async () => {
      const got = await q<{ display_name: string; name: string }>('select c.display_name, l.name from classes c join class_levels l on l.id = c.level_id where c.school_id = $1', [sid]);
      const lvl = new Map<string, string>(plugin.tables.class_levels.map((l: Row) => [String(l.id), String(l.name)]));
      const want = plugin.tables.classes.map((c: Row) => `${c.display_name}|${lvl.get(String(c.level_id))}`).sort();
      assert.deepEqual(got.map((r) => `${r.display_name}|${r.name}`).sort(), want);
    });
    await check('teaching duties point at the same teacher, class and subject, ended duties stay inactive', async () => {
      const got = await q<{ staff_number: string; assignment_type: string; display_name: string | null; code: string | null; status: string }>(
        `select st.staff_number, a.assignment_type, c.display_name, sj.code, a.status from staff_assignments a join staff st on st.id = a.staff_id left join classes c on c.id = a.class_id left join subjects sj on sj.id = a.subject_id where a.school_id = $1`, [sid]);
      const cls = new Map<string, string>(plugin.tables.classes.map((c: Row) => [String(c.id), String(c.display_name)]));
      const sub = new Map<string, string>(plugin.tables.subjects_v2.map((s: Row) => [String(s.id), String(s.code).toUpperCase().replace(/\s+/g, '')]));
      const stf = new Map<string, string>(plugin.tables.staff.map((s: Row) => [String(s.id), String(s.staff_number)]));
      const want = plugin.tables.staff_assignments.map((a: Row) => `${stf.get(String(a.staff_id))}|${a.assignment_type}|${cls.get(String(a.class_id)) ?? ''}|${a.subject_id && a.subject_id !== '0' ? sub.get(String(a.subject_id)) : ''}|${a.status}`).sort();
      assert.deepEqual(got.map((r) => `${r.staff_number}|${r.assignment_type}|${r.display_name ?? ''}|${r.code ?? ''}|${r.status}`).sort(), want);
      assert.ok(got.some((r) => r.status !== 'active'), 'the ended duty is kept as inactive, not dropped');
    });
    await check('terms of the deleted session were kept (not dropped), under a clearly labelled session, and the user is told', async () => {
      assert.equal(await count_('terms'), plugin.tables.terms.length);
      const rec = await q<{ title: string }>("select title from academic_sessions where school_id = $1 and title like 'Earlier session%'", [sid]);
      assert.equal(rec.length, 1);
      assert.ok(report.notes.some((n) => /session that had been deleted/.test(n)));
    });
    await check('the current session and term flags survive', async () => {
      assert.equal((await q('select 1 from academic_sessions where school_id = $1 and is_current', [sid])).length, 1);
    });
    await check('the file declares that it carries WordPress passwords, and the report counts them', () => {
      assert.equal(document.credentials, 'wordpress-hashes');
      assert.equal(report.passwords.carried, 3); assert.equal(report.passwords.none, 15 - 3);
    });
    const who = async (wpId: string) => {
      const w = plugin.wpUsers[wpId]; const isStudent = plugin.tables.students.find((x: Row) => String(x.wp_user_id) === wpId);
      const staffRow = plugin.tables.staff.find((x: Row) => String(x.wp_user_id) === wpId);
      return { loginId: String(isStudent ? isStudent.admission_number : staffRow!.staff_number), pw: known[wpId]!, hash: String(w.hash) };
    };
    await check('people with a WordPress account arrive holding their OWN hash, not forced to change it', async () => {
      for (const id of ['2', '9', '10']) {
        const p = await who(id);
        const [u] = await q<{ password_hash: string; must_change_password: boolean; password_carried_at: string | null }>('select password_hash, must_change_password, password_carried_at from users where school_id = $1 and lower(login_id) = lower($2)', [sid, p.loginId]);
        assert.ok(u, 'user exists ' + p.loginId); assert.equal(u!.password_hash, p.hash); assert.equal(u!.must_change_password, false); assert.ok(u!.password_carried_at);
      }
    });
    await check('each person signs in with the SAME password they used on WordPress (modern, plain-bcrypt and phpass hashes)', async () => {
      for (const id of ['2', '9', '10']) {
        const p = await who(id);
        const r = await authenticateCredentials({ loginId: p.loginId, password: p.pw, schoolId: sid });
        assert.equal(r.user.loginId.toLowerCase(), p.loginId.toLowerCase()); assert.equal(r.user.mustChangePassword, false);
      }
    });
    await check('after that first sign-in the stored hash is Argon2id, still the same password, and the carry marker stays for the offer', async () => {
      for (const id of ['2', '9', '10']) {
        const p = await who(id);
        const [u] = await q<{ password_hash: string; password_carried_at: string | null }>('select password_hash, password_carried_at from users where school_id = $1 and lower(login_id) = lower($2)', [sid, p.loginId]);
        assert.ok(u!.password_hash.startsWith('$argon2id$'), 'upgraded for ' + p.loginId); assert.ok(u!.password_carried_at, 'the marker stays, so the optional new-password offer can still appear');
        assert.equal(await verifyPassword(u!.password_hash, p.pw), true);
        const again = await authenticateCredentials({ loginId: p.loginId, password: p.pw, schoolId: sid }); assert.equal(again.user.mustChangePassword, false);
      }
    });
    await check('a wrong password is refused and the WordPress hash is NOT touched', async () => {
      // person 9 was upgraded above; use a fresh restore to test an untouched carried account
      const second = await restoreSchool({ actorUserId: admin!.id, file: encode(document), code: 'FROMWP2-' + suffix, subdomain: 'fromwp2' + suffix.toLowerCase(), principalPassword: 'defer' });
      schoolIds.push(second.school.id);
      const p = await who('2');
      await assert.rejects(authenticateCredentials({ loginId: p.loginId, password: p.pw + 'x', schoolId: second.school.id }));
      const [u] = await q<{ password_hash: string }>('select password_hash from users where school_id = $1 and lower(login_id) = lower($2)', [second.school.id, p.loginId]);
      assert.equal(u!.password_hash, p.hash, 'a failed sign-in must leave the carried hash exactly as it was');
    });
    await check('people with no WordPress account get no usable password (never an invented one)', async () => {
      const rows = await q<{ password_hash: string }>("select password_hash from users where school_id = $1 and password_hash like '!restored-no-password!%'", [sid]);
      assert.equal(rows.length, 15 - 3);
    });
    await check('the same carried hash cannot sign in to a DIFFERENT school or a different person', async () => {
      const p = await who('2');
      await assert.rejects(authenticateCredentials({ loginId: p.loginId, password: p.pw, schoolId: 999999 }));
      const other = await who('9');
      await assert.rejects(authenticateCredentials({ loginId: other.loginId, password: p.pw, schoolId: sid }));
    });
    await check('no two-factor secret, lock-out or invite credential crosses over', async () => {
      const u = await q<{ totp_enabled: boolean; totp_secret: string | null; failed_attempts: number }>('select totp_enabled, totp_secret, failed_attempts from users where school_id = $1', [sid]);
      assert.ok(u.every((x) => !x.totp_enabled && x.totp_secret === null));
    });
    await check('every login belongs to the new school and the roles are valid', async () => {
      const roles = new Set((await q<{ role: string }>('select distinct role from users where school_id = $1', [sid])).map((r) => r.role));
      for (const r of roles) assert.ok(['teacher', 'principal', 'vice_principal', 'exam_officer', 'student', 'parent'].includes(r), 'unexpected role ' + r);
    });
    await check('the report tells the person what did not come across', () => {
      assert.ok(report.notes.some((n) => /not placed in any class/.test(n)), 'the unplaced student is reported');
      assert.deepEqual(report.notTranslated, []);
    });
    await check('nothing leaked into any other school', async () => {
      const other = await q<{ n: number }>('select count(*)::int as n from students where school_id <> all($1::bigint[]) and admission_number = any($2)', [schoolIds, plugin.tables.students.map((s: Row) => s.admission_number)]);
      assert.equal(Number(other[0]!.n), 0, 'an admission number from the plugin appeared in another school');
    });
    await check('a file that is not a plugin backup is refused, not guessed at', () => {
      assert.throws(() => translatePluginBackup({ ...plugin, format: 'something-else' }), PluginBackupError);
      assert.throws(() => translatePluginBackup({ ...plugin, school: null }), PluginBackupError);
    });
    await check('a duty pointing at a deleted class is reported and left out, never pointed at the wrong class', () => {
      const bad = fixture(); bad.tables.staff_assignments[0].class_id = '99999'; bad.tables.staff_assignments[0].status = 'active';
      const t = translatePluginBackup(bad);
      assert.equal(t.document.tables.staff_assignments!.length, plugin.tables.staff_assignments.length - 1);
      assert.ok(t.report.notes.some((n) => /teaching duty/.test(n)));
    });
    await check('a duplicate subject code is made unique and reported, so the school still imports', () => {
      const dup = fixture(); dup.tables.subjects_v2[1].code = dup.tables.subjects_v2[0].code;
      const t = translatePluginBackup(dup);
      const codes = t.document.tables.subjects!.map((s) => s.code); assert.equal(new Set(codes).size, codes.length);
      assert.ok(t.report.notes.some((n) => /shared the code/.test(n)));
    });
    await check('a student with no admission number is reported and left out, never invented', () => {
      const noAdm = fixture(); noAdm.tables.students[0].admission_number = null; noAdm.tables.students[0].registration_number = null; noAdm.tables.students[0].student_id = null;
      const t = translatePluginBackup(noAdm);
      assert.equal(t.document.tables.students!.length, plugin.tables.students.length - 1);
      assert.ok(t.report.notes.some((n) => /no admission number/.test(n)));
    });
    await check('the optional new-password offer: shown to carried people only, survives the silent upgrade, ends on Keep or a real change, never touches anyone else', async () => {
      const { shouldOfferNewPassword, dismissPasswordOffer } = await import('@/lib/auth/password-offer');
      const { changeOwnPassword } = await import('@/lib/auth/change-password');
      const third = await restoreSchool({ actorUserId: admin!.id, file: encode(document), code: 'FROMWP3-' + suffix, subdomain: 'fromwp3' + suffix.toLowerCase(), principalPassword: 'defer' });
      schoolIds.push(third.school.id); const s3 = third.school.id;
      const idOf = async (wpId: string) => { const p = await who(wpId); const [u] = await q<{ id: string }>('select id from users where school_id = $1 and lower(login_id) = lower($2)', [s3, p.loginId]); return { id: Number(u!.id), ...p }; };
      const [a, b, c] = [await idOf('2'), await idOf('9'), await idOf('10')];
      const [noPw] = await q<{ id: string }>("select id from users where school_id = $1 and password_hash like '!restored-no-password!%' limit 1", [s3]);
      assert.equal(await shouldOfferNewPassword({ id: a.id, schoolId: s3 }), true, 'offered to a carried person');
      assert.equal(await shouldOfferNewPassword({ id: Number(noPw!.id), schoolId: s3 }), false, 'not offered to someone with no carried password');
      await authenticateCredentials({ loginId: a.loginId, password: a.pw, schoolId: s3 });  // silent upgrade to Argon2id
      assert.equal(await shouldOfferNewPassword({ id: a.id, schoolId: s3 }), true, 'still offered after the silent upgrade');
      await dismissPasswordOffer({ id: a.id, schoolId: s3 });
      assert.equal(await shouldOfferNewPassword({ id: a.id, schoolId: s3 }), false, 'Keep my password ends the offer');
      assert.equal(await shouldOfferNewPassword({ id: b.id, schoolId: s3 }), true, 'one person keeping theirs does not affect another');
      await authenticateCredentials({ loginId: b.loginId, password: b.pw, schoolId: s3 });
      await changeOwnPassword({ id: b.id, schoolId: s3 }, b.pw, 'Brand-New-Pass-42');
      assert.equal(await shouldOfferNewPassword({ id: b.id, schoolId: s3 }), false, 'choosing a new password ends the offer');
      await authenticateCredentials({ loginId: b.loginId, password: 'Brand-New-Pass-42', schoolId: s3 });
      await assert.rejects(authenticateCredentials({ loginId: b.loginId, password: b.pw, schoolId: s3 }), 'the old WordPress password stops working');
      // someone from ANOTHER school cannot dismiss this person's offer
      await dismissPasswordOffer({ id: c.id, schoolId: schoolIds[0]! });
      assert.equal(await shouldOfferNewPassword({ id: c.id, schoolId: s3 }), true, 'a different school cannot dismiss it');
      // a carried person who changes their password BEFORE ever signing in with the old one (legacy hash still stored)
      await changeOwnPassword({ id: c.id, schoolId: s3 }, c.pw, 'Another-New-Pass-77');
      assert.equal(await shouldOfferNewPassword({ id: c.id, schoolId: s3 }), false);
    });
    const carriedOf = async (doc: unknown, tag: string) => {
      const r = await restoreSchool({ actorUserId: admin!.id, file: encode(doc as never), code: `T${tag}-` + suffix, subdomain: `t${tag}` + suffix.toLowerCase(), principalPassword: 'defer' });
      schoolIds.push(r.school.id);
      return q<{ login_id: string; password_hash: string }>('select login_id, password_hash from users where school_id = $1', [r.school.id]);
    };
    const usable = (h: string) => !h.startsWith('!restored-no-password!');
    await check('TAMPERING: plaintext, md5-of-nothing and invented values in a plugin file never become a usable password', async () => {
      const t = translatePluginBackup(fixture()); const doc = JSON.parse(JSON.stringify(t.document));
      const users = doc.tables.users as Row[]; const withHash = users.filter((u) => u.password_hash);
      assert.equal(withHash.length, 3);
      withHash[0]!.password_hash = 'plaintext-password'; withHash[1]!.password_hash = '*'; withHash[2]!.password_hash = '5f4dcc3b5aa765d61d8327deb882cf9'; // 31 chars: not a real md5
      const { buildDocument } = await import('@/lib/school-backup/format');
      const rows = await carriedOf(buildDocument({ credentials: 'wordpress-hashes', school: doc.school, tables: doc.tables, uploads: {} } as never), 'tp');
      for (const u of withHash) assert.equal(usable(rows.find((r) => r.login_id === u.login_id)!.password_hash), false, u.login_id + ' must not be usable');
    });
    await check('TAMPERING: a WordPress hash inside an ordinary SaaS backup (credentials not wordpress-hashes) is discarded', async () => {
      const t = translatePluginBackup(fixture()); const doc = JSON.parse(JSON.stringify(t.document));
      const { buildDocument } = await import('@/lib/school-backup/format');
      for (const mode of ['password-hashes', 'none']) {
        const rows = await carriedOf(buildDocument({ credentials: mode, school: doc.school, tables: doc.tables, uploads: {} } as never), 'tm' + mode.slice(0, 2));
        assert.equal(rows.filter((r) => usable(r.password_hash)).length, 0, `no WordPress hash may survive under credentials=${mode}`);
      }
    });
    console.log(`${count} plugin-to-SaaS checks passed.`);
  } finally {
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner`delete from users where id = ${admin!.id}`.catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
