/**
 * Idempotent fixtures for the communications browser QA: a few unread
 * notifications for the demo principal and parent, a published school-wide
 * announcement, and one draft awaiting the publish walk.
 *
 *   DATABASE_URL_UNPOOLED=... npx tsx tmp-qa/prep-comms.ts
 */
import pg from 'pg';

async function main() {
  const c = new pg.Client(process.env.DATABASE_URL_UNPOOLED!);
  await c.connect();

  const { rows: [school] } = await c.query(`select id from schools order by id limit 1`);
  const schoolId = school.id as number;

  const u = async (loginId: string) =>
    (await c.query(`select id from users where school_id = $1 and login_id = $2`, [schoolId, loginId])).rows[0]?.id;

  const principal = await u('PRINCIPAL');
  const parent = await u('PAREVIEW');
  if (!principal || !parent) throw new Error('PRINCIPAL / PAREVIEW missing — run the seed first');

  await c.query(`delete from notifications where school_id = $1 and user_id = any($2)`, [schoolId, [principal, parent]]);
  await c.query(
    `insert into notifications (school_id, user_id, type, title, body, link)
     values ($1,$2,'result_published','QA notice: results are out','First-term results have been published.','/portal/my-results'),
            ($1,$2,'announcement','QA notice: welcome back','Welcome to the new session.','/portal'),
            ($1,$3,'message_received','QA notice: you have a message','Folake Adeyemi started a conversation.','/portal/messages')`,
    [schoolId, principal, parent]);

  await c.query(`delete from announcements where school_id = $1 and subject like 'QA %'`, [schoolId]);
  // author_user_id references the user, not the staff record.
  const { rows: [teacher] } = await c.query(
    `select id, user_id from staff where school_id = $1 and staff_number = 'STF001'`, [schoolId]);
  if (!teacher) throw new Error('staff records missing — run the seed first');
  const { rows: [klass] } = await c.query(
    `select id from classes where school_id = $1 order by id limit 1`, [schoolId]);
  await c.query(
    `insert into announcements (school_id, author_user_id, audience, audience_ref, subject, body, status, published_at)
     values ($1,$2,'school',null,'QA Resumption notice','The school resumes on Monday the 8th.','published',now()),
            ($1,$3,'class',$4,'QA Class draft','A draft only leadership can publish.','draft',null)`,
    [schoolId, principal, teacher.user_id, klass.id]);

  console.log('comms prep: 3 notifications, 1 published + 1 draft announcement');
  await c.end();
}
main();
