/**
 * Idempotent demo-school fixtures for the dashboard browser QA:
 * a vice-principal login, a parent login with one shared + one withheld
 * child link, and a pending-approval student so the office dashboard's
 * "Pending office actions" panel is exercised.
 *
 *   DATABASE_URL_UNPOOLED=... npx tsx tmp-qa/prep-dashboards.ts
 */
import pg from 'pg';
import { hashPassword } from '@/lib/auth/password';

const PW = 'Qa-Baseline-2026!';

async function main() {
  const c = new pg.Client(process.env.DATABASE_URL_UNPOOLED!);
  await c.connect();

  const { rows: [school] } = await c.query(`select id from schools order by id limit 1`);
  if (!school) throw new Error('demo school missing — run the seed first');
  const schoolId = school.id;

  const known = await hashPassword(PW);

  // Vice-principal login + staff row.
  await c.query(
    `insert into users (school_id, role, login_id, password_hash, must_change_password)
     values ($1, 'vice_principal', 'VPREVIEW', $2, false)
     on conflict (school_id, login_id) do update set password_hash = $2, must_change_password = false`,
    [schoolId, known]);
  const { rows: [vp] } = await c.query(`select id from users where school_id = $1 and login_id = 'VPREVIEW'`, [schoolId]);
  await c.query(
    `insert into staff (school_id, user_id, staff_number, first_name, last_name, role, status)
     values ($1, $2, 'STF-VP', 'Vee', 'Pee', 'vice_principal', 'active')
     on conflict (school_id, staff_number) do nothing`,
    [schoolId, vp.id]);

  // Parent login + guardian with one shared and one withheld child link.
  await c.query(
    `insert into users (school_id, role, login_id, password_hash, must_change_password)
     values ($1, 'parent', 'PAREVIEW', $2, false)
     on conflict (school_id, login_id) do update set password_hash = $2, must_change_password = false`,
    [schoolId, known]);
  const { rows: [parent] } = await c.query(`select id from users where school_id = $1 and login_id = 'PAREVIEW'`, [schoolId]);
  await c.query(
    `insert into guardians (school_id, user_id, full_name, email)
     values ($1, $2, 'Parent Review', 'parent.review@example.com')`,
    [schoolId, parent.id]);
  const { rows: [guardian] } = await c.query(
    `select id from guardians where school_id = $1 and user_id = $2`, [schoolId, parent.id]);
  const { rows: children } = await c.query(
    `select s.id from students s join users u on u.id = s.user_id
     where s.school_id = $1 and u.login_id = any($2) order by s.id`,
    [schoolId, ['2026010001', '2026010002']]);
  if (children.length < 2) throw new Error(`expected 2 demo students, found ${children.length}`);
  await c.query(`delete from guardian_student where school_id = $1 and guardian_id = $2`, [schoolId, guardian.id]);
  await c.query(
    `insert into guardian_student (school_id, guardian_id, student_id, can_view_results)
     values ($1, $2, $3, true), ($1, $2, $4, false)`,
    [schoolId, guardian.id, children[0].id, children[1].id]);

  // A pending-approval student so the office dashboard has a real action.
  await c.query(
    `insert into users (school_id, role, login_id, password_hash, must_change_password)
     values ($1, 'student', 'PENDREVIEW', $2, false)
     on conflict (school_id, login_id) do update set password_hash = $2`,
    [schoolId, known]);
  const { rows: [pendUser] } = await c.query(`select id from users where school_id = $1 and login_id = 'PENDREVIEW'`, [schoolId]);
  await c.query(
    `insert into students (school_id, user_id, admission_number, first_name, last_name, status)
     values ($1, $2, 'PEND-0001', 'Pend', 'Ing', 'pending_approval')
     on conflict (school_id, admission_number) do nothing`,
    [schoolId, pendUser.id]);

  // Keep the seeded logins on the QA password too.
  await c.query(
    `update users set password_hash = $1, must_change_password = false
     where login_id = any($2)`,
    [known, ['PRINCIPAL', 'STF001', '2026010001']]);

  console.log('prep: VPREVIEW, PAREVIEW + children links, PEND-0001 ready');
  await c.end();
}

main();
