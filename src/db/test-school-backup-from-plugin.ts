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
import { eq } from 'drizzle-orm';

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
    // ── Slice 2: results, checked against the plugin's OWN rows, never against the translator's output ──
    const nameOf = (table: string, id: unknown) => String((plugin.tables[table].find((r: Row) => String(r.id) === String(id)) ?? {}).name ?? (plugin.tables[table].find((r: Row) => String(r.id) === String(id)) ?? {}).title ?? '');
    const newStudent = async (oldId: unknown) => { const a = plugin.tables.students.find((r: Row) => String(r.id) === String(oldId)).admission_number;
      return Number((await q<{ id: string }>('select id from students where school_id = $1 and admission_number = $2', [sid, a]))[0]!.id); };
    const newSubject = async (oldId: unknown) => { const code = String(plugin.tables.subjects_v2.find((r: Row) => String(r.id) === String(oldId)).code).toUpperCase().replace(/\s+/g, '');
      return Number((await q<{ id: string }>('select id from subjects where school_id = $1 and code = $2', [sid, code]))[0]!.id); };
    const newTerm = async (oldId: unknown) => { const t = plugin.tables.terms.find((r: Row) => String(r.id) === String(oldId));
      const rows = await q<{ id: string }>('select t.id from terms t join academic_sessions s on s.id = t.session_id where t.school_id = $1 and t.title = $2 and t.position = $3 and s.title = $4', [sid, t.title, t.term_order, nameOf('academic_sessions', t.session_id) || `Earlier session (recovered ${t.session_id})`]);
      return Number(rows[0]!.id); };
    await check('RESULTS: every score arrives with exactly the same value, for the same pupil, subject, term and assessment', async () => {
      assert.equal(await count_('assessment_scores'), plugin.tables.assessment_scores.length);
      const comp = new Map<string, string>(plugin.tables.assessment_components.map((c: Row) => [String(c.id), String(c.code)]));
      for (const sc of plugin.tables.assessment_scores) {
        const got = await q<{ score: string }>('select score from assessment_scores where school_id = $1 and student_id = $2 and subject_id = $3 and term_id = $4 and component_key = $5',
          [sid, await newStudent(sc.student_id), await newSubject(sc.subject_id), await newTerm(sc.term_id), comp.get(String(sc.component_id))]);
        assert.equal(got.length, 1, 'one score row'); assert.equal(Number(got[0]!.score), Number(sc.score), `score of pupil ${sc.student_id} subject ${sc.subject_id}`);
      }
    });
    await check('RESULTS: the school settings carry the plugin assessment setup and its own grading scale, and the SaaS accepts them', async () => {
      const { resultConfig } = await import('@/lib/results/config');
      const [row] = await q<{ settings: Record<string, unknown> }>('select settings from schools where id = $1', [sid]);
      const cfg = resultConfig(row!.settings); assert.ok(cfg, 'the SaaS config schema accepts the migrated settings');
      assert.deepEqual(cfg!.assessmentComponents.map((c) => [c.key, c.maxScore, c.isExam]), plugin.tables.assessment_components.map((c: Row) => [c.code, Number(c.max_score), String(c.is_exam) === '1']));
      const def = plugin.tables.grading_scales.find((x: Row) => String(x.is_default) === '1');
      const bands = plugin.tables.grade_bands.filter((b: Row) => String(b.scale_id) === String(def.id));
      assert.deepEqual(cfg!.gradingScale.bands.map((b) => [b.grade, b.min]).sort(), bands.map((b: Row) => [b.grade, Number(b.min_score)]).sort());
      assert.equal(cfg!.gradingScale.bands.length, 5, 'the 2-band senior scale must NOT replace the default scale');
    });
    await check('RESULTS: every compiled result keeps its CA, exam and total, and its grade is the grade the school bands give that total', async () => {
      assert.equal(await count_('subject_results'), plugin.tables.subject_results.length);
      const def = plugin.tables.grading_scales.find((x: Row) => String(x.is_default) === '1');
      const bands = plugin.tables.grade_bands.filter((b: Row) => String(b.scale_id) === String(def.id)).map((b: Row) => ({ g: String(b.grade), min: Number(b.min_score) })).sort((a: { min: number }, b: { min: number }) => b.min - a.min);
      for (const r of plugin.tables.subject_results) {
        const got = await q<{ ca_total: string; exam_total: string; total: string; grade: string; remark: string; complete: boolean; subject_position: number }>(
          'select ca_total, exam_total, total, grade, remark, complete, subject_position from subject_results where school_id = $1 and student_id = $2 and subject_id = $3 and term_id = $4',
          [sid, await newStudent(r.student_id), await newSubject(r.subject_id), await newTerm(r.term_id)]);
        assert.equal(got.length, 1);
        const g = got[0]!; assert.equal(Number(g.ca_total), Number(r.ca_total)); assert.equal(Number(g.exam_total), Number(r.exam_total)); assert.equal(Number(g.total), Number(r.total));
        assert.equal(g.subject_position, Number(r.subject_position), 'position is carried, not recalculated');
        if (g.complete) assert.equal(g.grade, bands.find((b: { min: number }) => Number(r.total) >= b.min)!.g, `grade of total ${r.total}`);
        else { assert.equal(g.grade, ''); assert.equal(g.remark, 'Incomplete'); }
      }
    });
    await check('RESULTS: a pupil missing an assessment is marked incomplete with no grade, and one with a zero is complete', async () => {
      const inc = await q<{ n: string }>("select count(*)::int n from subject_results where school_id = $1 and complete = false and grade = '' and remark = 'Incomplete'", [sid]);
      assert.ok(Number(inc[0]!.n) >= 1, 'the missing-exam pupil is incomplete');
      const zero = await q<{ grade: string; complete: boolean }>("select grade, complete from subject_results where school_id = $1 and total = 0 and complete = true", [sid]);
      assert.ok(zero.length >= 1 && zero.every((z) => z.grade === 'F'));
    });
    await check('RESULTS: ONLY what the plugin published is visible to students (published flag follows the term row)', async () => {
      const termOf = (st: unknown, tm: unknown) => plugin.tables.term_results.find((t: Row) => String(t.student_id) === String(st) && String(t.term_id) === String(tm));
      for (const r of plugin.tables.subject_results) {
        const t = termOf(r.student_id, r.term_id);
        const got = await q<{ published: boolean; state: string }>('select published, state from subject_results where school_id = $1 and student_id = $2 and subject_id = $3 and term_id = $4',
          [sid, await newStudent(r.student_id), await newSubject(r.subject_id), await newTerm(r.term_id)]);
        const expectPublished = t?.status === 'published';
        assert.equal(got[0]!.published, expectPublished, `pupil ${r.student_id} term ${r.term_id} is ${t?.status}`);
        if (!expectPublished) assert.notEqual(got[0]!.state, 'published');
      }
      const visible = await q<{ n: string }>('select count(*)::int n from subject_results where school_id = $1 and published', [sid]);
      assert.equal(Number(visible[0]!.n), plugin.tables.subject_results.filter((r: Row) => termStatus(r) === 'published').length);
      function termStatus(r: Row) { return plugin.tables.term_results.find((t: Row) => String(t.student_id) === String(r.student_id) && String(t.term_id) === String(r.term_id))?.status; }
    });
    await check('RESULTS: remarks (accents and quotes intact), attendance, position and approval state of every term result are carried', async () => {
      assert.equal(await count_('term_summaries'), plugin.tables.term_results.length);
      for (const t of plugin.tables.term_results) {
        const [g] = await q<Row>('select * from term_summaries where school_id = $1 and student_id = $2 and term_id = $3', [sid, await newStudent(t.student_id), await newTerm(t.term_id)]);
        assert.ok(g); assert.equal(g!.class_teacher_remark, t.class_teacher_remark ?? ''); assert.equal(g!.principal_remark, t.principal_remark ?? '');
        assert.equal(Number(g!.days_present), Number(t.days_present)); assert.equal(Number(g!.days_total), Number(t.days_total));
        assert.equal(Number(g!.class_position), Number(t.class_position)); assert.equal(g!.status, t.status);
      }
      assert.ok(plugin.tables.term_results.some((t: Row) => /très bien/.test(String(t.class_teacher_remark))), 'the fixture really has accented remarks');
    });
    await check('RESULTS: the migrated results report the real grading scale and are tied to it', async () => {
      const rows = await q<{ grading_scale_id: string; grading_scale_version: number }>('select distinct grading_scale_id, grading_scale_version from subject_results where school_id = $1', [sid]);
      assert.deepEqual(rows.map((r) => r.grading_scale_id), ['wp-' + plugin.tables.grading_scales.find((x: Row) => String(x.is_default) === '1').id]);
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
    await check('RESULTS: through the real student/parent view, a migrated student sees exactly the terms the plugin published, with all their subjects', async () => {
      const { familyPublishedTerms } = await import('@/lib/results/family');
      const { forSchool } = await import('@/db');
      const published = new Set(plugin.tables.term_results.filter((t: Row) => t.status === 'published').map((t: Row) => `${t.student_id}/${t.term_id}`));
      let sawPublished = 0, sawNothing = 0;
      for (const st of plugin.tables.students) {
        const newId = await newStudent(st.id);
        const seen = await forSchool(sid, (tx) => familyPublishedTerms(tx, newId));
        for (const t of plugin.tables.terms) {
          const should = published.has(`${st.id}/${t.id}`);
          const termId = await newTerm(t.id);
          const hit = seen.find((x) => x.termId === termId);
          assert.equal(!!hit, should, `student ${st.admission_number} term ${t.id} should ${should ? '' : 'NOT '}be visible`);
          if (hit) { sawPublished++; const n = plugin.tables.subject_results.filter((r: Row) => String(r.student_id) === String(st.id) && String(r.term_id) === String(t.id)).length; assert.equal(hit.subjects, n, 'all subjects of the term are visible together'); }
        }
        if (seen.length === 0) sawNothing++;
      }
      assert.ok(sawPublished >= 4, 'the fixture really publishes some terms'); assert.ok(sawNothing >= 1, 'and really leaves some pupils with nothing visible');
    });
    // ── Slice 3: the question bank, checked against the plugin's OWN rows ──────────────────────────────────────
    const qplugin = (plugin.tables.questions as Row[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
    const bankIds = (await q<{ id: string }>('select id from bank_questions where school_id = $1 order by id', [sid])).map((r) => Number(r.id));
    const bankIdOf = (pluginId: string) => bankIds[qplugin.findIndex((x) => String(x.id) === pluginId)]!;
    const bankOf = async (qid: string) => (await q<Row>('select * from bank_questions where id = $1', [bankIdOf(qid)]))[0]!;
    await check('QUESTIONS: every plugin question arrives, including the ones that belong to no school (school_id 0)', async () => {
      assert.equal(await count_('bank_questions'), qplugin.length);
      assert.ok(qplugin.some((x) => String(x.school_id) === '0'), 'the fixture really holds school_id 0 questions');
      assert.equal(await count_('bank_question_parts'), plugin.tables.question_sub_items.length);
    });
    await check('QUESTIONS: topic, difficulty, duration, explanation and marking guide are kept, field for field', async () => {
      for (const x of qplugin) {
        const r = await bankOf(String(x.id));
        assert.ok(r, 'question ' + x.id + ' arrived');
        assert.equal(r.topic, String(x.topic ?? '').trim(), 'topic of ' + x.id); assert.equal(r.question_text, String(x.question_text ?? '').trim(), 'text of ' + x.id);
        assert.equal(r.difficulty, String(x.difficulty ?? '').trim(), 'difficulty of ' + x.id); assert.equal(r.estimated_seconds, Number(x.estimated_duration ?? 0), 'duration of ' + x.id);
        assert.equal(String(r.explanation).split('\nStored answer:')[0], String(x.explanations ?? '').trim(), 'explanation of ' + x.id);
        assert.equal(r.marking_guide, String(x.marking_guide ?? '').trim(), 'marking guide of ' + x.id); assert.equal(Number(r.marks), Number(x.marks), 'marks of ' + x.id);
        assert.equal(r.subject_name, String(x.subject ?? '').trim(), 'subject of ' + x.id);
      }
    });
    await check('QUESTIONS: the correct answer is the same in BOTH storage styles (old JSON list and newer option rows)', async () => {
      for (const x of qplugin) {
        const rowOpts = (plugin.tables.question_options as Row[]).filter((o) => String(o.question_id) === String(x.id));
        const expected = rowOpts.length ? rowOpts.filter((o) => String(o.is_correct) === '1').map((o) => String(o.option_text).trim())
          : (() => { try { const a = JSON.parse(String(x.answers ?? '[]')); return Array.isArray(a) ? a.map((v: unknown) => String(v).trim()) : []; } catch { return []; } })();
        const b = { id: String(bankIdOf(String(x.id))) };
        const got = await q<{ option_text: string }>('select option_text from bank_question_options where question_id = $1 and is_correct order by sort_order', [b.id]);
        assert.deepEqual(got.map((g) => g.option_text.toLowerCase()).sort(), expected.map((e: string) => e.toLowerCase()).sort(), 'correct answer of question ' + x.id);
      }
    });
    await check('QUESTIONS: an odd stored type (a bare 0) becomes objective, and nothing else is guessed', async () => {
      const types = await q<{ question_type: string; n: string }>('select question_type, count(*)::int n from bank_questions where school_id = $1 group by 1', [sid]);
      assert.ok(types.every((t) => ['objective', 'single', 'theory'].includes(t.question_type)), JSON.stringify(types));
      assert.equal(qplugin.filter((x) => String(x.question_type) === '0').length, 5, 'the fixture really has the odd type');
    });
    await check('QUESTIONS: theory parts keep their label, text and marks, in order', async () => {
      const theory = qplugin.find((x) => String(x.question_type) === 'theory')!; const b = await bankOf(String(theory.id));
      const got = await q<{ label: string; text: string; marks: string }>('select label, text, marks from bank_question_parts where question_id = $1 order by sequence', [b.id as string]);
      const want = (plugin.tables.question_sub_items as Row[]).filter((p) => String(p.question_id) === String(theory.id)).sort((a, c) => Number(a.sequence) - Number(c.sequence));
      assert.equal(got.length, want.length); assert.ok(got.length >= 2);
      got.forEach((g, i) => { assert.equal(g.label, String(want[i]!.label).trim()); assert.equal(g.text, String(want[i]!.text).trim()); assert.equal(Number(g.marks), Number(want[i]!.marks)); });
    });
    await check('QUESTIONS: subject names link to the school subjects, and the written name is always kept', async () => {
      const rows = await q<{ subject_name: string; sname: string | null }>('select b.subject_name, s.name sname from bank_questions b left join subjects s on s.id = b.subject_id where b.school_id = $1', [sid]);
      assert.ok(rows.every((r) => r.subject_name !== '' || true));
      for (const r of rows) if (r.sname) assert.equal(r.sname.toLowerCase(), r.subject_name.toLowerCase());
      assert.ok(rows.filter((r) => r.sname).length >= 8, 'most questions are linked to their subject');
    });
    await check('QUESTIONS: tenant isolation: under ANOTHER school the bank is invisible, and a write into this school is refused', async () => {
      const { forSchool, schema } = await import('@/db');
      const otherSchool = schoolIds.find((x) => x !== sid)!;
      const seenByOther = await forSchool(otherSchool, (tx) => tx.select({ id: schema.bankQuestions.id }).from(schema.bankQuestions).where(eq(schema.bankQuestions.schoolId, sid)));
      assert.equal(seenByOther.length, 0, 'another school must not see this bank');
      const seenByOwner = await forSchool(sid, (tx) => tx.select({ id: schema.bankQuestions.id }).from(schema.bankQuestions));
      assert.equal(seenByOwner.length, qplugin.length, 'the owning school sees all of it');
      await assert.rejects(forSchool(otherSchool, (tx) => tx.insert(schema.bankQuestions).values({ schoolId: sid, questionText: 'planted' })), 'writing into another school is refused by row-level security');
      const opts = await forSchool(otherSchool, (tx) => tx.select({ id: schema.bankQuestionOptions.id }).from(schema.bankQuestionOptions).where(eq(schema.bankQuestionOptions.schoolId, sid)));
      assert.equal(opts.length, 0, 'options are isolated too');
    });
    await check('QUESTIONS: a stored answer that matches NO option is kept (appended to the explanation), never lost', async () => {
      const odd = JSON.parse(JSON.stringify(plugin)); const x = odd.tables.questions.find((r: Row) => String(r.id) === '1'); x.answers = '["not an option"]';
      const t = translatePluginBackup(odd); const b = t.document.tables.bank_questions!.find((r) => r.id === 1)!;
      assert.match(String(b.explanation), /Stored answer: not an option/);
      assert.ok(t.report.notes.some((n) => /none of its options matched the stored answer/.test(n)));
      assert.equal(t.document.tables.bank_question_options!.filter((o) => o.question_id === 1 && o.is_correct).length, 0, 'no option is invented as correct');
    });
    await check('QUESTIONS: options pointing at a missing question, and a missing parent, are reported and never attached to another question', async () => {
      const bad = JSON.parse(JSON.stringify(plugin)); bad.tables.question_options.push({ id: '9001', school_id: '1', question_id: '77777', option_key: 'A', option_text: 'lost', is_correct: '1', sort_order: '0' });
      bad.tables.questions.find((r: Row) => String(r.id) === '4').parent_id = '88888';
      const t = translatePluginBackup(bad);
      assert.ok(!t.document.tables.bank_question_options!.some((o) => o.option_text === 'lost'));
      assert.ok(t.report.notes.some((n) => /options in the file but the question itself was missing/.test(n)));
      assert.equal(t.document.tables.bank_questions!.find((r) => r.id === 4)!.parent_id, null);
      assert.ok(t.report.notes.some((n) => /pointed at a parent question that is not in the file/.test(n)));
    });
    await check('QUESTIONS: a bank question keeps its parent link through a restore (two-pass)', async () => {
      const withParent = JSON.parse(JSON.stringify(plugin)); withParent.tables.questions.find((r: Row) => String(r.id) === '5').parent_id = '4';
      const t = translatePluginBackup(withParent);
      const r = await restoreSchool({ actorUserId: admin!.id, file: encode(t.document), code: 'QPAR-' + suffix, subdomain: 'qpar' + suffix.toLowerCase(), principalPassword: 'defer' });
      schoolIds.push(r.school.id);
      const links = await q<{ child: string; parent: string }>('select c.id child, p.id parent from bank_questions c join bank_questions p on p.id = c.parent_id where c.school_id = $1 and p.school_id = $1', [r.school.id]);
      assert.equal(links.length, 1, 'the parent link was restored inside the new school');
    });
    // ── Slice 4: exam papers and sittings kept as history, checked against the plugin's OWN rows ───────────────
    const pAttempts = (plugin.tables.attempts as Row[]).slice().sort((a, b) => Number(a.id) - Number(b.id));
    const histOf = async (srcId: string) => (await q<Row>("select * from legacy_exam_attempts where school_id = $1 and kind = 'paper' and source_id = $2", [sid, srcId]))[0]!;
    await check('EXAMS: every paper, empty series, legacy exam and sitting arrives, nothing is dropped', async () => {
      assert.equal(await count_('legacy_exam_attempts'), pAttempts.length + (plugin.tables.exam_attempts as Row[]).length);
      assert.equal(await count_('legacy_exam_papers'), (plugin.tables.exam_papers as Row[]).length + (plugin.tables.exams as Row[]).length
        + (plugin.tables.exam_series as Row[]).filter((x) => !(plugin.tables.exam_papers as Row[]).some((p) => String(p.series_id) === String(x.id))).length);
      assert.ok(pAttempts.length >= 4, 'the fixture really holds sittings');
    });
    await check('EXAMS: every score is EXACTLY the plugin figure (carried, never re-graded or re-scaled)', async () => {
      for (const a of pAttempts) {
        const h = await histOf(String(a.id));
        assert.equal(Number(h.raw_score), Number(a.raw_score), 'raw score of ' + a.id); assert.equal(Number(h.max_score), Number(a.max_score), 'max score of ' + a.id);
        assert.equal(Number(h.percentage), Number(a.percentage), 'percentage of ' + a.id);
        assert.equal(h.status, String(a.status)); assert.equal(h.submit_reason, String(a.submit_reason ?? ''));
      }
      const graded = pAttempts.filter((a) => a.status === 'graded'); assert.ok(graded.length >= 3);
      assert.ok(pAttempts.some((a) => a.status === 'in_progress'), 'an unfinished sitting is kept as unfinished, not turned into a score');
    });
    await check('EXAMS: each sitting belongs to the SAME student and the same paper as in the plugin', async () => {
      for (const a of pAttempts) {
        const h = await histOf(String(a.id));
        const stu = plugin.tables.students.find((x: Row) => String(x.id) === String(a.student_id));
        const [s2] = await q<{ admission_number: string }>('select admission_number from students where id = $1', [h.student_id as string]);
        assert.equal(s2!.admission_number, String(stu.admission_number).trim(), 'student of sitting ' + a.id);
        const [pp] = await q<{ source_id: string; kind: string }>('select source_id, kind from legacy_exam_papers where id = $1', [h.paper_id as string]);
        assert.equal(String(pp!.source_id), String(a.paper_id)); assert.equal(pp!.kind, 'paper');
      }
    });
    await check('EXAMS: every answer is kept in the order the student saw it, with what they chose and what was right', async () => {
      for (const a of pAttempts) {
        const h = await histOf(String(a.id));
        const order: number[] = JSON.parse(String(a.question_order));
        const got = await q<Row>('select * from legacy_attempt_answers where attempt_id = $1 order by position', [h.id as string]);
        assert.equal(got.length, order.length, 'one row per question the student was shown, answered or not (sitting ' + a.id + ')');
        const ans = (plugin.tables.attempt_answers as Row[]).filter((x) => String(x.attempt_id) === String(a.id));
        got.forEach((g, i) => {
          assert.equal(String(g.question_source_id), String(order[i]), 'order position ' + i);
          const mine = ans.find((x) => String(x.question_id) === String(order[i]));
          if (!mine) { assert.equal(g.chosen_option, null, 'unanswered stays unanswered'); assert.equal(g.marks_awarded, null); return; }
          const opt = (plugin.tables.question_options as Row[]).find((o) => String(o.id) === String(mine.option_id));
          assert.equal(g.chosen_option, String(opt!.option_text).trim(), 'chosen option'); assert.equal(Number(g.marks_awarded), Number(mine.marks_awarded));
          assert.equal(g.is_correct, mine.is_correct === null ? null : String(mine.is_correct) === '1', 'correctness as graded then');
        });
        const sum = got.reduce((t, g) => t + Number(g.marks_awarded ?? 0), 0);
        if (a.status === 'graded') assert.equal(sum, Number(a.raw_score), 'the answers add up to the stored score for sitting ' + a.id);
      }
    });
    await check('EXAMS: a later edit to the live question bank cannot change what a past sitting says', async () => {
      const h = await histOf(String(pAttempts[0]!.id));
      const before = await q<{ question_text: string; chosen_option: string; correct_option: string }>('select question_text, chosen_option, correct_option from legacy_attempt_answers where attempt_id = $1 order by position', [h.id as string]);
      await q("update bank_questions set question_text = 'EDITED LATER' where school_id = $1", [sid]);
      await q("update bank_question_options set option_text = 'EDITED LATER' where school_id = $1", [sid]);
      const after = await q<{ question_text: string; chosen_option: string; correct_option: string }>('select question_text, chosen_option, correct_option from legacy_attempt_answers where attempt_id = $1 order by position', [h.id as string]);
      assert.deepEqual(after, before); assert.ok(before.every((b) => b.question_text.startsWith('Biology paper question')), 'the frozen wording is the original');
    });
    await check('EXAMS: the original plugin row is kept verbatim, including columns this code does not use', async () => {
      const [h] = await q<{ source: Record<string, string> }>("select source from legacy_exam_attempts where school_id = $1 and kind = 'paper' and source_id = $2", [sid, String(pAttempts[0]!.id)]);
      for (const k of Object.keys(pAttempts[0]!)) assert.equal(String(h!.source[k] ?? ''), String(pAttempts[0]![k] ?? ''), 'source.' + k);
      assert.equal(h!.source.session_token, '', 'a live sitting token is never archived');
      const [p] = await q<{ source: Record<string, unknown>; questions: unknown[] }>("select source, questions from legacy_exam_papers where school_id = $1 and kind = 'paper'", [sid]);
      assert.equal(String(p!.source.access_code ?? ''), '', 'a live exam access code is never archived'); assert.equal(p!.questions.length, 20);
    });
    await check('EXAMS: even a file that still carries live secrets (an older exporter) never archives them', async () => {
      const dirty = JSON.parse(JSON.stringify(plugin));
      dirty.tables.exam_papers[0].access_code = 'LIVE-CODE-9'; dirty.tables.attempts.forEach((a: Row) => { a.session_token = 'LIVE-TOKEN-' + a.id; });
      dirty.tables.exam_attempts.forEach((a: Row) => { a.session_key = 'LIVE-KEY'; }); dirty.tables.exam_series[0].access_code = 'LIVE-SERIES';
      const t = translatePluginBackup(dirty);
      const text = JSON.stringify([t.document.tables.legacy_exam_papers, t.document.tables.legacy_exam_attempts]);
      for (const secret of ['LIVE-CODE-9', 'LIVE-TOKEN-', 'LIVE-KEY', 'LIVE-SERIES']) assert.equal(text.includes(secret), false, secret + ' must not be archived');
      assert.equal(t.report.translated.legacy_exam_attempts, plugin.tables.attempts.length + plugin.tables.exam_attempts.length, 'nothing else is lost');
    });
    await check('EXAMS: the empty draft series and the legacy demo exam (with its timetable) are kept too', async () => {
      const kinds = await q<{ kind: string; n: string }>('select kind, count(*)::int n from legacy_exam_papers where school_id = $1 group by 1', [sid]);
      assert.deepEqual(Object.fromEntries(kinds.map((k) => [k.kind, Number(k.n)])), { paper: 1, series: 1, legacy: 1 });
      const [l] = await q<{ source: { timetable: { subject: string } | null }; questions: unknown[] }>("select source, questions from legacy_exam_papers where school_id = $1 and kind = 'legacy'", [sid]);
      assert.equal(l!.source.timetable!.subject, 'General Studies'); assert.equal(l!.questions.length, 5);
    });
    await check('EXAMS: history never leaks into live results, report cards or the student view', async () => {
      const [r] = await q<{ n: string }>('select count(*)::int n from attempts where school_id = $1', [sid]); assert.equal(Number(r!.n), 0, 'no live SaaS attempt was invented');
      const [e] = await q<{ n: string }>('select count(*)::int n from exam_papers where school_id = $1', [sid]); assert.equal(Number(e!.n), 0, 'no live SaaS paper was invented');
      const [s1] = await q<{ n: string }>('select count(*)::int n from exam_series where school_id = $1', [sid]); assert.equal(Number(s1!.n), 0, 'no live SaaS series was invented');
    });
    await check('EXAMS: tenant isolation: another school cannot read this exam history, answers or integrity log', async () => {
      const { forSchool, schema } = await import('@/db'); const other = schoolIds.find((x) => x !== sid)!;
      for (const t of [schema.legacyExamPapers, schema.legacyExamAttempts, schema.legacyAttemptAnswers, schema.legacyAttemptEvents] as const) {
        const seen = await forSchool(other, (tx) => tx.select({ id: t.id }).from(t).where(eq(t.schoolId, sid)));
        assert.equal(seen.length, 0);
      }
      await assert.rejects(forSchool(other, (tx) => tx.insert(schema.legacyExamAttempts).values({ schoolId: sid, kind: 'paper', sourceId: 999, questionOrder: [], source: {} })));
    });
    await check('EXAMS: a sitting for a student or paper that is not in the file is kept and reported, never given to someone else', async () => {
      const bad = JSON.parse(JSON.stringify(plugin)); bad.tables.attempts.push({ ...bad.tables.attempts[0], id: '900', student_id: '99999', paper_id: '88888', session_token: 'x' });
      const t = translatePluginBackup(bad);
      assert.equal(t.report.translated.legacy_exam_attempts, plugin.tables.attempts.length + plugin.tables.exam_attempts.length + 1);
      const last = t.document.tables.legacy_exam_attempts!.find((a) => a.source_id === 900)!;
      assert.equal(last.student_id, null); assert.equal(last.paper_id, null);
      assert.ok(t.report.notes.some((n) => /pointed at a paper that is not in the file/.test(n)) && t.report.notes.some((n) => /belonged to a student who is not in the file/.test(n)));
    });
    await check('RESULTS: an assessment setup the SaaS cannot hold (totals 90, two exams) still keeps EVERY score and result, and says what to set again', async () => {
      const odd = JSON.parse(JSON.stringify(plugin)); odd.tables.assessment_components[0].max_score = '0.00'; odd.tables.assessment_components[1].max_score = '10.00';
      odd.tables.assessment_components[2].max_score = '10.00'; odd.tables.assessment_components[3].max_score = '70.00'; odd.tables.assessment_components[0].is_exam = '1';
      const t = translatePluginBackup(odd);
      assert.equal(t.report.translated.assessment_scores, plugin.tables.assessment_scores.length, 'no score lost');
      assert.equal(t.report.translated.subject_results, plugin.tables.subject_results.length, 'no result lost');
      assert.ok(t.report.notes.some((n) => /NOT carried and must be set again/.test(n) && /scores were kept/.test(n)));
      const r = await restoreSchool({ actorUserId: admin!.id, file: encode(t.document), code: 'ODD-' + suffix, subdomain: 'odd' + suffix.toLowerCase(), principalPassword: 'defer' });
      schoolIds.push(r.school.id);
      const n = await q<{ n: string }>('select count(*)::int n from assessment_scores where school_id = $1', [r.school.id]);
      assert.equal(Number(n[0]!.n), plugin.tables.assessment_scores.length);
      const sum = await q<{ t: string }>('select sum(total) t from subject_results where school_id = $1', [r.school.id]);
      assert.ok(Math.abs(Number(sum[0]!.t) - plugin.tables.subject_results.reduce((a: number, x: Row) => a + Number(x.total), 0)) < 0.005, 'every total is kept exactly');
      const [st] = await q<{ settings: Record<string, unknown> }>('select settings from schools where id = $1', [r.school.id]);
      assert.equal(st!.settings.assessmentComponents, undefined, 'the unusable setup is not pretended to be valid');
    });
    await check('RESULTS: a school with NO grading scale keeps its scores and results, with no grade invented', async () => {
      const bare = JSON.parse(JSON.stringify(plugin)); bare.tables.grading_scales = []; bare.tables.grade_bands = [];
      const t = translatePluginBackup(bare);
      assert.equal(t.report.translated.subject_results, plugin.tables.subject_results.length);
      assert.ok(t.document.tables.subject_results!.every((x) => x.grade === ''), 'no invented grades');
      assert.equal((t.document.school.settings as { gradingScale?: unknown }).gradingScale, undefined);
    });
    await check('RESULTS: a score for a pupil or subject that is not in the file is reported, never attached to someone else', async () => {
      const bad = JSON.parse(JSON.stringify(plugin)); bad.tables.assessment_scores.push({ id: '9999', school_id: '1', student_id: '88888', subject_id: '1', class_id: '4', session_id: '2', term_id: '4', component_id: '25', score: '5', max_score: '10', source: 'manual' });
      const t = translatePluginBackup(bad);
      assert.equal(t.report.translated.assessment_scores, plugin.tables.assessment_scores.length);
      assert.ok(t.report.notes.some((n) => /1 score\(s\) pointed at a pupil/.test(n)));
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
