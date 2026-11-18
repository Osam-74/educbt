/**
 * School backup UPLOAD + JOB checks: chunked upload with server-side verification, the background
 * restore body, idempotency, failure reporting, and that no password or data lingers in job rows.
 *   npx tsx src/db/test-school-backup-upload.ts
 * Run against a disposable LOCAL database; never production.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_UNPOOLED']) {
    const url = new URL(process.env[key] ?? '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
      throw new Error('Backup upload tests require a disposable local *_ca_test database.');
    }
  }
  const { schema } = await import('@/db');
  const { exportSchool } = await import('@/lib/school-backup/export');
  const up = await import('@/lib/school-backup/upload');
  const { runRestoreJob, friendlyRestoreError } = await import('@/lib/school-backup/job');
  const { hashPassword, verifyPassword } = await import('@/lib/auth/password');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const schoolIds: number[] = []; const jobIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const slices = (file: Buffer, size: number) => { const out: Buffer[] = []; for (let i = 0; i < file.length; i += size) out.push(file.subarray(i, i + size)); return out; };

  const [admin] = await db.insert(schema.users).values({ schoolId: null, role: 'platform_admin', loginId: 'padmin-' + suffix, passwordHash: 'x', mustChangePassword: false }).returning();
  const actor = Number(admin!.id);

  // A source school with a few hundred students, so the file spans several pieces at a small piece size.
  const [src] = await db.insert(schema.schools).values({ name: 'Upload Source College', code: 'US' + suffix, subdomain: 'us' + suffix.toLowerCase() }).returning();
  const sourceId = src!.id; schoolIds.push(sourceId);
  const [session] = await db.insert(schema.academicSessions).values({ schoolId: sourceId, title: '2025/26', isCurrent: true }).returning();
  const [pu] = await db.insert(schema.users).values({ schoolId: sourceId, role: 'principal', loginId: 'PRN-' + suffix, passwordHash: 'x', mustChangePassword: false }).returning();
  await db.insert(schema.staff).values({ schoolId: sourceId, userId: pu!.id, role: 'principal', staffNumber: 'PRN-0001', firstName: 'Pat', lastName: 'Head' });
  await db.insert(schema.students).values(Array.from({ length: 400 }, (_, i) => ({ schoolId: sourceId, admissionNumber: `ADM/${suffix}/${i}`, firstName: 'Student' + i, lastName: randomUUID() })));
  void session;
  const exported = await exportSchool(sourceId);
  const file = exported.file;
  const PIECE = Math.max(1024, Math.ceil(file.length / 4)); // forces several pieces regardless of file size

  const plan = (over: Partial<Parameters<typeof up.startUpload>[1]> = {}) => ({
    fileName: 'greenfield.educbt-school.gz', totalBytes: file.length, totalChunks: Math.ceil(file.length / PIECE), sha256: sha(file),
    code: 'UP' + suffix + randomUUID().slice(0, 4).toUpperCase(), subdomain: null, ...over,
  });
  const start = async (over = {}) => { const { jobId } = await up.startUpload(actor, plan(over)); jobIds.push(jobId); return jobId; };
  const sendAll = async (jobId: number, parts = slices(file, PIECE)) => { for (let i = 0; i < parts.length; i++) await up.addChunk(actor, jobId, i, parts[i]!); };
  const statusOf = async (id: number) => (await q(`select status::text as s, error_message as e, restored_school_id as r, summary from school_backup_jobs where id = $1`, [id]))[0]!;
  const chunksOf = async (id: number) => (await q(`select count(*)::int as n from school_backup_chunks where job_id = $1`, [id]))[0]!.n as number;

  try {
    await check('the test file really spans several pieces', () => assert.ok(slices(file, PIECE).length >= 4, 'file too small to test chunking'));

    // ── upload rules ──────────────────────────────────────────────────────
    await check('a valid multi-piece upload is accepted and queued', async () => {
      const id = await start(); await sendAll(id);
      assert.deepEqual(await up.completeUpload(actor, id), { queued: true });
      assert.equal((await statusOf(id)).s, 'queued');
    });
    await check('re-sending a piece (network retry) replaces it and never duplicates', async () => {
      const id = await start(); const parts = slices(file, PIECE);
      await up.addChunk(actor, id, 0, parts[0]!); await up.addChunk(actor, id, 0, parts[0]!); await up.addChunk(actor, id, 0, parts[0]!);
      assert.equal(await chunksOf(id), 1);
      for (let i = 1; i < parts.length; i++) await up.addChunk(actor, id, i, parts[i]!);
      assert.deepEqual(await up.completeUpload(actor, id), { queued: true });
    });
    await check('pieces may arrive in any order', async () => {
      const id = await start(); const parts = slices(file, PIECE);
      for (const i of [...parts.keys()].reverse()) await up.addChunk(actor, id, i, parts[i]!);
      assert.deepEqual(await up.completeUpload(actor, id), { queued: true });
    });
    await check('a missing piece is refused, the job fails and the pieces are deleted', async () => {
      const id = await start(); const parts = slices(file, PIECE);
      for (let i = 0; i < parts.length - 1; i++) await up.addChunk(actor, id, i, parts[i]!);
      await assert.rejects(() => up.completeUpload(actor, id), /pieces arrived/);
      assert.equal((await statusOf(id)).s, 'failed'); assert.equal(await chunksOf(id), 0);
    });
    await check('a damaged piece is caught by the whole-file checksum', async () => {
      const id = await start(); const parts = slices(file, PIECE);
      const bad = Buffer.from(parts[1]!); bad[10] = bad[10]! ^ 0xff;
      for (let i = 0; i < parts.length; i++) await up.addChunk(actor, id, i, i === 1 ? bad : parts[i]!);
      await assert.rejects(() => up.completeUpload(actor, id), /checksum|damaged/);
      assert.equal((await statusOf(id)).s, 'failed'); assert.equal(await chunksOf(id), 0);
    });
    await check('a lied-about total size is caught', async () => {
      const id = await start({ totalBytes: file.length + 5 }); await sendAll(id);
      await assert.rejects(() => up.completeUpload(actor, id), /size does not match/);
    });
    await check('an oversized piece is refused', async () => {
      const id = await start();
      await assert.rejects(() => up.addChunk(actor, id, 0, Buffer.alloc(up.MAX_CHUNK_BYTES + 1)), /larger than allowed/);
    });
    await check('a piece outside the declared plan is refused', async () => {
      const id = await start();
      await assert.rejects(() => up.addChunk(actor, id, 999, Buffer.from('x')), /outside the declared/);
    });
    await check('an empty piece and a negative position are refused', async () => {
      const id = await start();
      await assert.rejects(() => up.addChunk(actor, id, 0, Buffer.alloc(0)), /Empty/);
      await assert.rejects(() => up.addChunk(actor, id, -1, Buffer.from('x')), /position/);
    });
    await check('bad plans are refused before anything is stored', async () => {
      await assert.rejects(() => up.startUpload(actor, plan({ totalBytes: 0 })), /empty/);
      await assert.rejects(() => up.startUpload(actor, plan({ sha256: 'nothex' })), /checksum/);
      await assert.rejects(() => up.startUpload(actor, plan({ code: 'bad code!' })), /school code/);
      await assert.rejects(() => up.startUpload(actor, plan({ subdomain: 'Bad_Sub' })), /subdomain/);
      await assert.rejects(() => up.startUpload(actor, plan({ totalChunks: 1, totalBytes: up.MAX_CHUNK_BYTES * 3 })), /not valid/);
      await assert.rejects(() => up.startUpload(actor, plan({ totalBytes: 10 ** 12 })), /larger than the supported/);
    });
    await check('a school code that already exists is refused up front, before a long upload', async () => {
      await assert.rejects(() => up.startUpload(actor, plan({ code: 'US' + suffix })), /already exists/);
      await assert.rejects(() => up.startUpload(actor, plan({ subdomain: 'us' + suffix.toLowerCase() })), /already exists/);
    });
    await check('a finished upload cannot take more pieces or be finished twice', async () => {
      const id = await start(); await sendAll(id); await up.completeUpload(actor, id);
      await assert.rejects(() => up.addChunk(actor, id, 0, Buffer.from('x')), /no longer accepting/);
      await assert.rejects(() => up.completeUpload(actor, id), /already finished/);
    });
    await check('cancelling deletes the pieces; a job that has already ended cannot be cancelled', async () => {
      const id = await start(); await up.addChunk(actor, id, 0, Buffer.from('abc'));
      await up.cancelJob(actor, id);
      assert.equal(await chunksOf(id), 0); assert.equal((await statusOf(id)).s, 'cancelled');
      await assert.rejects(() => up.cancelJob(actor, id), /has not started restoring/);
    });

    // ── the restore job body ──────────────────────────────────────────────
    const schoolsNow = async () => (await q(`select count(*)::int as n from schools`))[0]!.n as number;

    await check('JOB: restores the uploaded school, records success, and DELETES the pieces', async () => {
      const code = 'JB' + suffix; const id = await start({ code, subdomain: code.toLowerCase(), name: 'Restored Via Job' }); await sendAll(id); await up.completeUpload(actor, id);
      const out = await runRestoreJob(id, actor);
      assert.equal(out.ok, true);
      const s = await statusOf(id);
      assert.equal(s.s, 'succeeded'); assert.ok(s.r); schoolIds.push(Number(s.r));
      assert.equal(await chunksOf(id), 0, 'the uploaded school data must not linger after the restore');
      assert.equal((await q(`select name from schools where id = $1`, [s.r]))[0]!.name, 'Restored Via Job');
      assert.equal((await q(`select count(*)::int as n from students where school_id = $1`, [s.r]))[0]!.n, 400);
      assert.equal((s.summary as Record<string, number>).students, 400);
    });
    await check('JOB: NO password is generated, stored or visible anywhere in the job row', async () => {
      const [r] = await q(`select * from school_backup_jobs where status = 'succeeded' and new_school_code = $1`, ['JB' + suffix]);
      const text = JSON.stringify(r).toLowerCase();
      assert.ok(!text.includes('password') && !text.includes('temporary'), 'the job row must not mention a password');
      const [p] = await q(`select password_hash from users where school_id = $1 and role = 'principal'`, [r!.restored_school_id]);
      assert.ok(String(p!.password_hash).startsWith('!restored-no-password!'), 'principal has no usable password until one is issued');
    });
    await check('JOB: a file WITH password hashes keeps everyone\'s password and still stores no password in the job row', async () => {
      const realHash = await hashPassword('Old-password-2026');
      await owner`update users set password_hash = ${realHash}, must_change_password = false where school_id = ${sourceId} and role = 'principal'`;
      const withPw = await exportSchool(sourceId, { includePasswords: true });
      const file2 = withPw.file;
      const code = 'PJ' + suffix;
      const { jobId } = await up.startUpload(actor, { fileName: withPw.fileName, totalBytes: file2.length, totalChunks: Math.ceil(file2.length / PIECE), sha256: sha(file2), code, subdomain: code.toLowerCase() });
      jobIds.push(jobId);
      const parts = slices(file2, PIECE); for (let i = 0; i < parts.length; i++) await up.addChunk(actor, jobId, i, parts[i]!);
      await up.completeUpload(actor, jobId);
      const out = await runRestoreJob(jobId, actor);
      assert.equal(out.ok, true);
      const s = await statusOf(jobId); schoolIds.push(Number(s.r));
      const [p] = await q(`select password_hash, must_change_password from users where school_id = $1 and role = 'principal'`, [s.r]);
      assert.equal(await verifyPassword(String(p!.password_hash), 'Old-password-2026'), true, 'the principal must keep the password they had');
      const [row] = await q(`select * from school_backup_jobs where id = $1`, [jobId]);
      assert.ok(!JSON.stringify(row).includes('argon2'), 'a password hash must never sit in a job row');
      assert.equal(await chunksOf(jobId), 0);
    });
    await check('JOB: running the same job again does NOT restore twice (idempotent)', async () => {
      const [r] = await q(`select id from school_backup_jobs where status = 'succeeded' and new_school_code = $1`, ['JB' + suffix]);
      const before = await schoolsNow();
      const again = await runRestoreJob(Number(r!.id), actor);
      assert.equal(again.ok, false); assert.equal(await schoolsNow(), before);
    });
    await check('JOB: a job that is not queued is not started', async () => {
      const id = await start(); await up.addChunk(actor, id, 0, Buffer.from('x'));
      const out = await runRestoreJob(id, actor);
      assert.equal(out.ok, false); assert.match((out as { message: string }).message, /uploading/);
    });
    await check('JOB: a code taken between upload and restore fails in plain English, leaves no school, deletes the pieces', async () => {
      const code = 'RC' + suffix; const id = await start({ code }); await sendAll(id); await up.completeUpload(actor, id);
      await db.insert(schema.schools).values({ name: 'Squatter', code, subdomain: null }).then(async () => {}); // someone takes it meanwhile
      const before = await schoolsNow();
      const out = await runRestoreJob(id, actor);
      assert.equal(out.ok, false);
      const s = await statusOf(id);
      assert.equal(s.s, 'failed'); assert.match(String(s.e), /already exists/i);
      assert.ok(!/error:|stack|postgres|constraint|violates/i.test(String(s.e)), 'no internal detail in the message shown to the operator');
      assert.equal(await schoolsNow(), before); assert.equal(await chunksOf(id), 0);
      await owner`delete from schools where code = ${code}`;
    });
    await check('JOB: a corrupt file that passed upload is refused by the document check, rolled back, pieces deleted', async () => {
      const junk = Buffer.from('this is definitely not a gzip backup but it is long enough to upload '.repeat(50));
      const id = (await up.startUpload(actor, { fileName: 'junk.gz', totalBytes: junk.length, totalChunks: 1, sha256: sha(junk), code: 'JK' + suffix })).jobId; jobIds.push(id);
      await up.addChunk(actor, id, 0, junk); await up.completeUpload(actor, id);
      const before = await schoolsNow(); const out = await runRestoreJob(id, actor);
      assert.equal(out.ok, false); assert.equal((await statusOf(id)).s, 'failed'); assert.match(String((await statusOf(id)).e), /not a valid EduCBT/);
      assert.equal(await schoolsNow(), before); assert.equal(await chunksOf(id), 0);
    });
    await check('friendly errors never leak internals', () => {
      for (const e of [new Error('duplicate key value violates unique constraint "schools_code_uq" 23505'), new Error('connection terminated'), new Error('relation "x" does not exist')]) {
        const m = friendlyRestoreError(e);
        assert.ok(!/violates|constraint|relation|terminated|23505/i.test(m), m);
      }
    });

    // ── access ────────────────────────────────────────────────────────────
    await check('ACCESS: without platform elevation the upload tables are invisible (RLS), even to the app role', async () => {
      const { db: appDb } = await import('@/db');
      const { sql } = await import('drizzle-orm');
      const jobsSeen = await appDb.execute(sql`select count(*)::int as n from school_backup_jobs`);
      const chunksSeen = await appDb.execute(sql`select count(*)::int as n from school_backup_chunks`);
      assert.equal((jobsSeen as unknown as Array<{ n: number }>)[0]!.n, 0, 'a non-elevated connection must see no jobs');
      assert.equal((chunksSeen as unknown as Array<{ n: number }>)[0]!.n, 0);
      await assert.rejects(() => appDb.execute(sql`insert into school_backup_jobs (created_by, file_name, total_bytes, total_chunks, sha256, new_school_code) values (1, 'x', 1, 1, 'a', 'z')`));
    });
    await check('every elevated call leaves an audit entry', async () => {
      assert.ok((await q(`select count(*)::int as n from audit_log where action = 'platform_admin.elevated_access' and reason like 'Upload restore chunk%'`))[0]!.n as number > 0);
    });

    console.log('\n' + count + ' checks passed.');
  } finally {
    for (const id of jobIds) await owner`delete from school_backup_jobs where id = ${id}`.catch(() => {});
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner`delete from audit_log where actor_user_id = ${actor}`.catch(() => {});
    await owner`delete from users where id = ${actor}`.catch(() => {});
    await owner.end();
    const { client } = await import('@/db'); await client.end({ timeout: 2 }).catch(() => {});
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
