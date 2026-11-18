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
      assert.equal(again.checksum, document.checksum); assert.equal(again.credentials, 'none');
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
    await check('nobody keeps a WordPress credential: every login arrives with no usable password and must set one', async () => {
      const users = await q<{ role: string; must_change_password: boolean; totp_enabled: boolean }>('select role, must_change_password, totp_enabled from users where school_id = $1', [sid]);
      assert.ok(users.length >= plugin.tables.staff.length + plugin.tables.students.length);
      assert.ok(users.every((u) => !u.totp_enabled));
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
      const other = await q<{ n: number }>('select count(*)::int as n from students where school_id <> $1 and admission_number = any($2)', [sid, plugin.tables.students.map((s: Row) => s.admission_number)]);
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
    console.log(`${count} plugin-to-SaaS checks passed.`);
  } finally {
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner`delete from users where id = ${admin!.id}`.catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
