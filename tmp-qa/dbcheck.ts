import pg from 'pg';
async function main() {
  const c = new pg.Client(process.env.DATABASE_URL_UNPOOLED!);
  await c.connect();
  console.log('pg:', (await c.query('select version()')).rows[0].version.slice(0, 40));
  console.log('role:', (await c.query("select rolname from pg_roles where rolname='educbt_app'")).rows.map(r => r.rolname));
  console.log('dbs:', (await c.query("select datname from pg_database where datname like 'educbt%'")).rows.map(r => r.datname));
  await c.end();
}
main();
