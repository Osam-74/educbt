/**
 * Idempotent demo-school fixtures for the promotion/transcript browser QA:
 * a level with classes, two sessions with three terms, subjects, and two
 * students with full published results (one promotable, one terminal graduate)
 * so the promotion office, the transcript office and the issued document can
 * be walked end to end with real clicks.
 *
 *   DATABASE_URL_UNPOOLED=... npx tsx tmp-qa/prep-promotion.ts
 */
import pg from 'pg';
import { hashPassword } from '@/lib/auth/password';

const PW = 'Qa-Baseline-2026!';
const L1 = 'QA Promote One';
const L2 = 'QA Promote Two';
const L3 = 'QA Terminal';

async function main() {
  const c = new pg.Client(process.env.DATABASE_URL_UNPOOLED!);
  await c.connect();

  const { rows: [school] } = await c.query(`select id from schools order by id limit 1`);
  if (!school) throw new Error('demo school missing — run the seed first');
  const schoolId = school.id;

  const known = await hashPassword(PW);

  // Idempotency: clear batches/transcripts from a previous QA run so the
  // propose step always starts clean (browser QA may leave a proposed batch).
  await c.query(
    `delete from transcripts where school_id = $1 and student_id in (
       select student_id from promotion_decisions d
       join promotion_batches b on b.id = d.batch_id
       where b.school_id = $1 and b.level_id in (
         select id from class_levels where school_id = $1 and name in ($2, $3, $4)))`,
    [schoolId, L1, L2, L3]);
  await c.query(
    `delete from promotion_decisions where batch_id in (
       select id from promotion_batches where school_id = $1 and level_id in (
         select id from class_levels where school_id = $1 and name in ($2, $3, $4)))`,
    [schoolId, L1, L2, L3]);
  await c.query(
    `delete from promotion_batches where school_id = $1 and level_id in (
       select id from class_levels where school_id = $1 and name in ($2, $3, $4))`,
    [schoolId, L1, L2, L3]);

  // Principal login for the office flows.
  await c.query(
    `update users set password_hash = $2, must_change_password = false
     where school_id = $1 and role = 'principal'`,
    [schoolId, known]);

  const level = async (name: string, order: number) => {
    const { rows } = await c.query(
      `insert into class_levels (school_id, name, level_order) values ($1, $2, $3)
       on conflict (school_id, name) do update set level_order = $3 returning id`, [schoolId, name, order]);
    return rows[0].id as number;
  };
  const klass = async (levelId: number, name: string) => {
    const { rows } = await c.query(
      `insert into classes (school_id, level_id, display_name, arm) values ($1, $2, $3, $4)
       on conflict do nothing returning id`, [schoolId, levelId, name, name]);
    if (rows[0]) return rows[0].id as number;
    const { rows: [row] } = await c.query(
      `select id from classes where school_id = $1 and level_id = $2 and display_name = $3`, [schoolId, levelId, name]);
    return row.id as number;
  };
  const session = async (title: string, current: boolean) => {
    const { rows } = await c.query(
      `insert into academic_sessions (school_id, title, is_current) values ($1, $2, $3)
       on conflict (school_id, title) do update set is_current = $3 returning id`, [schoolId, title, current]);
    return rows[0].id as number;
  };
  const term = async (sessionId: number, title: string, position: number) => {
    const { rows } = await c.query(
      `insert into terms (school_id, session_id, title, position)
       select $1::bigint, $2::bigint, $3::varchar, $4::int where not exists (
         select 1 from terms where school_id = $1::bigint and session_id = $2::bigint and title = $3::varchar)
       returning id`, [schoolId, sessionId, title, position]);
    if (rows[0]) return rows[0].id as number;
    const { rows: [row] } = await c.query(
      `select id from terms where school_id = $1 and session_id = $2 and title = $3`, [schoolId, sessionId, title]);
    return row.id as number;
  };

  const l1 = await level(L1, 90);
  const l2 = await level(L2, 91);
  const l3 = await level(L3, 92);
  const c1 = await klass(l1, 'QA Stream A');
  const c2 = await klass(l2, 'QA Stream A');
  const c3 = await klass(l3, 'QA Stream A');

  const sFrom = await session('QA 2024/25', false);
  const sTo = await session('QA 2025/26', true);
  const t1 = await term(sFrom, 'First', 1);
  const t2 = await term(sFrom, 'Second', 2);
  const t3 = await term(sFrom, 'Third', 3);

  const subjectId = async (code: string, name: string) => {
    const { rows } = await c.query(
      `insert into subjects (school_id, code, name, is_compulsory) values ($1, $2, $3, true)
       on conflict (school_id, code) do update set name = $3 returning id`, [schoolId, code, name]);
    return rows[0].id as number;
  };
  const eng = await subjectId('QAENG', 'QA English');
  const mth = await subjectId('QAMTH', 'QA Mathematics');

  const student = async (admission: string, first: string, classId: number) => {
    await c.query(
      `insert into students (school_id, admission_number, first_name, last_name, status)
       values ($1, $2, $3, 'QA', 'active') on conflict (school_id, admission_number) do nothing`,
      [schoolId, admission, first]);
    const { rows: [row] } = await c.query(
      `select id from students where school_id = $1 and admission_number = $2`, [schoolId, admission]);
    await c.query(
      `insert into enrollments (school_id, student_id, class_id, session_id, status)
       values ($1, $2, $3, $4, 'active') on conflict do nothing`,
      [schoolId, row.id, classId, sFrom]);
    return row.id as number;
  };

  const publish = async (studentId: number, total: number) => {
    for (const t of [t1, t2, t3]) {
      for (const sub of [eng, mth]) {
        await c.query(
          `insert into subject_results (school_id, student_id, subject_id, session_id, term_id,
             total, grade, complete, state, published)
           values ($1, $2, $3, $4, $5, $6, $7, true, 'published', true)
           on conflict (student_id, subject_id, session_id, term_id)
           do update set total = $6, grade = $7, state = 'published', published = true`,
          [schoolId, studentId, sub, sFrom, t, String(total), total >= 50 ? 'C' : 'F']);
      }
    }
  };

  const promo = await student('QA/PROMO', 'Promo', c1);
  const grad = await student('QA/GRAD', 'Grad', c3);
  await publish(promo, 72);
  await publish(grad, 65);

  console.log(JSON.stringify({ schoolId, promo, grad, sFrom, sTo, l1, l2, l3, c1, c2, c3, admission: 'QA/PROMO' }));
  await c.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
