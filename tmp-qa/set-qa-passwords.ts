import pg from 'pg';
import { hashPassword } from '@/lib/auth/password';

async function main() {
  const c = new pg.Client(process.env.DATABASE_URL_UNPOOLED!);
  await c.connect();
  const known = await hashPassword('Qa-Baseline-2026!');
  const res = await c.query(
    `update users set password_hash = $1, must_change_password = false
     where login_id = any($2) returning login_id`, [known, ['PRINCIPAL', 'STF001', '2026010001']]);
  console.log('reset:', res.rows.map(r => r.login_id).join(', '));
  await c.end();
}
main();
