/**
 * School backup END TO END, in a real browser against a real production build:
 *   download a backup from a school's page  ->  upload it through the restore page in pieces
 *   ->  Inngest runs the restore in the background  ->  the new school exists with the right data.
 *
 * Needs: a built app, an Inngest dev server, Playwright. Disposable LOCAL database only.
 *
 * NOT part of the CI loop: CI has no Inngest server, and the background restore cannot run without
 * one. Run it by hand before a release that touches backup/restore:
 *   npx inngest-cli@latest dev -u http://127.0.0.1:3100/api/inngest --no-discovery --no-poll
 *   INNGEST_DEV=1 INNGEST_SIGNING_KEY=<any 64 hex> INNGEST_EVENT_KEY=x npx next start -p 3100
 * (the app's route refuses to serve production traffic without SOME signing key, so give it a dummy one;
 * with INNGEST_DEV=1 the SDK does not verify signatures from the local dev server.)
 *   BACKUP_BROWSER_MODULE=/tmp/educbt-browser/node_modules/playwright/index.mjs \
 *   BACKUP_BASE_URL=http://127.0.0.1:3100 npx tsx src/db/test-school-backup-browser.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

async function main() {
  const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.endsWith('_ca_test')) {
    throw new Error('The backup browser test requires a disposable local *_ca_test database.');
  }
  const base = new URL(process.env.BACKUP_BASE_URL ?? 'http://127.0.0.1:3100');
  const { chromium } = await import(process.env.BACKUP_BROWSER_MODULE ?? 'playwright');
  const { schema } = await import('@/db');
  const { createSession } = await import('@/lib/auth/session-store');
  const { hashPassword } = await import('@/lib/auth/password');

  const owner = postgres(process.env.DATABASE_URL_UNPOOLED!, { max: 1, onnotice: () => {} });
  const db = drizzle(owner, { schema });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => JSON.parse(JSON.stringify(await owner.unsafe(text, params as never[]))) as T[];
  const suffix = randomUUID().slice(0, 6).toUpperCase();
  const dir = mkdtempSync(join(tmpdir(), 'backup-e2e-'));
  const schoolIds: number[] = [];
  let count = 0;
  const check = async (name: string, fn: () => unknown | Promise<unknown>) => { await fn(); count++; console.log('PASS  ' + name); };

  const adminHash = await hashPassword('Admin-pass-2026');
  const [admin] = await db.insert(schema.users).values({ schoolId: null, role: 'platform_admin', loginId: 'E2E-ADMIN-' + suffix, passwordHash: adminHash, mustChangePassword: false }).returning();
  const [src] = await db.insert(schema.schools).values({ name: 'Greenfield E2E College', code: 'GE' + suffix, subdomain: 'ge' + suffix.toLowerCase(), address: '1 School Road' }).returning();
  const sourceId = src!.id; schoolIds.push(sourceId);
  await db.insert(schema.academicSessions).values({ schoolId: sourceId, title: '2026/27', isCurrent: true });
  const [pu] = await db.insert(schema.users).values({ schoolId: sourceId, role: 'principal', loginId: 'PRN-' + suffix, passwordHash: await hashPassword('Principal-pass-1'), mustChangePassword: false }).returning();
  await db.insert(schema.staff).values({ schoolId: sourceId, userId: pu!.id, role: 'principal', staffNumber: 'PRN-1', firstName: 'Pat', lastName: 'Head' });
  await db.insert(schema.students).values(Array.from({ length: 60 }, (_, i) => ({ schoolId: sourceId, admissionNumber: `ADM/${suffix}/${i}`, firstName: 'Pupil' + i, lastName: 'E2E' })));
  // A photo big enough that the file spans more than one 3 MB piece (random bytes do not compress).
  const { randomBytes } = await import('node:crypto');
  const photoToken = randomBytes(24).toString('base64url');
  await owner`insert into portal_uploads (school_id, token, mime_type, byte_size, data) values (${sourceId}, ${photoToken}, 'image/png', ${7 * 1024 * 1024}, ${randomBytes(7 * 1024 * 1024)})`;
  await owner`update schools set logo_url = ${'/api/photos/' + photoToken} where id = ${sourceId}`;

  const { token } = await createSession(Number(admin!.id), '127.0.0.1', 'backup-e2e');
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addCookies([{ name: 'educbt.session', value: token, url: base.origin }]); // NON-secure, as CI does
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  const consoleErrors: string[] = [];
  page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(404)/.test(m.text())) consoleErrors.push(m.text()); });

  try {
    // ── 1. Download from the school's page ────────────────────────────────
    let backupPath = '';
    await check('the school page offers a backup, with passwords OFF by default and the trade-off stated', async () => {
      await page.goto(`${base.origin}/platform/schools/${sourceId}`);
      await page.waitForSelector('#backup');
      assert.equal(await page.locator('#backup input[type=checkbox]').isChecked(), false);
      assert.match(await page.locator('#backup').innerText(), /holds no passwords/i);
      await page.locator('#backup input[type=checkbox]').check();
      assert.match(await page.locator('#backup').innerText(), /WITH-PASSWORDS/);
      await page.locator('#backup input[type=checkbox]').uncheck();
    });
    await check('downloading saves a real file named for the school and the date', async () => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download backup' }).click()]);
      const name = dl.suggestedFilename();
      assert.match(name, /^Greenfield-E2E-College-backup-\d{4}-\d{2}-\d{2}\.educbt-school\.gz$/);
      assert.ok(!/WITH-PASSWORDS/.test(name));
      backupPath = join(dir, name); await dl.saveAs(backupPath);
      assert.ok(readFileSync(backupPath).length > 5 * 1024 * 1024, 'the file should carry the 7 MB photo');
    });
    await check('the download is recorded in the school\'s activity log (who, and that no passwords were included)', async () => {
      await page.locator('#backup').getByText(/recorded in the school/).waitFor();
      const rows = await q(`select actor_role, after from audit_log where school_id = $1 and action = 'school.backup_taken'`, [sourceId]);
      assert.equal(rows.length, 1); assert.equal(rows[0]!.actor_role, 'platform_admin');
      assert.equal((rows[0]!.after as { includesPasswordHashes: boolean }).includesPasswordHashes, false);
    });
    await check('the file is larger than one piece, so the upload really is chunked', () => assert.ok(readFileSync(backupPath).length > 3 * 1024 * 1024));

    // ── 2. Upload it through the restore page ─────────────────────────────
    const newCode = 'RS' + suffix; const newSub = 'rs' + suffix.toLowerCase();
    await check('the restore page loads from the Schools directory', async () => {
      await page.goto(`${base.origin}/platform/schools`);
      await page.locator('#schools-restore-btn').click();
      await page.waitForURL('**/platform/schools/restore');
      await page.locator('#bk-file').waitFor();
    });
    await check('the upload runs in pieces and the restore completes in the background', async () => {
      const pieces: number[] = [];
      page.on('request', (r: { url(): string; method(): string }) => { const m = /\/upload\/\d+\/chunk\/(\d+)/.exec(r.url()); if (m && r.method() === 'PUT') pieces.push(Number(m[1])); });
      await page.setInputFiles('#bk-file', backupPath);
      await page.locator('#bk-code').fill(newCode);
      await page.locator('#bk-sub').fill(newSub);
      await page.getByRole('button', { name: 'Upload and restore' }).click();
      await page.getByText('School restored.').waitFor({ timeout: 150_000 });
      assert.ok(new Set(pieces).size >= 3, 'expected at least 3 distinct pieces, saw ' + [...new Set(pieces)].join(','));
    });

    // ── 3. The result, checked in the database ────────────────────────────
    const [restored] = await q(`select id, name, status::text as status, logo_url from schools where code = $1`, [newCode]);
    if (restored) schoolIds.push(Number(restored.id));
    await check('a NEW, active school exists with the old school\'s name', () => {
      assert.ok(restored, 'no restored school found'); assert.equal(restored!.status, 'active'); assert.equal(restored!.name, 'Greenfield E2E College');
      assert.notEqual(Number(restored!.id), sourceId);
    });
    await check('all 60 students and the principal came across', async () => {
      assert.equal((await q(`select count(*)::int as n from students where school_id = $1`, [restored!.id]))[0]!.n, 60);
      assert.equal((await q(`select count(*)::int as n from staff where school_id = $1 and role = 'principal'`, [restored!.id]))[0]!.n, 1);
    });
    await check('the 7 MB logo travelled byte-for-byte under a NEW token', async () => {
      const newPath = String(restored!.logo_url); assert.match(newPath, /^\/api\/photos\//); assert.ok(!newPath.endsWith(photoToken));
      const [orig] = await q<{ md5: string }>(`select md5(data) as md5 from portal_uploads where token = $1`, [photoToken]);
      const [copy] = await q<{ md5: string }>(`select md5(data) as md5 from portal_uploads where token = $1`, [newPath.split('/').pop()]);
      assert.equal(copy!.md5, orig!.md5);
      const res = await page.request.get(base.origin + newPath); assert.equal(res.status(), 200);
      assert.equal((await res.body()).length, 7 * 1024 * 1024);
    });
    await check('the original school is untouched', async () => {
      assert.equal((await q(`select count(*)::int as n from students where school_id = $1`, [sourceId]))[0]!.n, 60);
    });
    await check('no password sits in the job row and the uploaded pieces are gone', async () => {
      const [job] = await q(`select * from school_backup_jobs where new_school_code = $1`, [newCode]);
      assert.equal(job!.status, 'succeeded'); assert.ok(!/argon2|password/i.test(JSON.stringify(job)));
      assert.equal((await q(`select count(*)::int as n from school_backup_chunks where job_id = $1`, [job!.id]))[0]!.n, 0);
    });
    await check('the restored principal has NO usable password until one is issued (default backup)', async () => {
      const [p] = await q(`select password_hash from users where school_id = $1 and role = 'principal'`, [restored!.id]);
      assert.ok(String(p!.password_hash).startsWith('!restored-no-password!'));
    });

    // ── 3b. Issue the principal a password, through the real button ───────
    let issuedPw = '';
    await check('PASSWORD: the restored school offers "Issue principal password", and it needs a confirmation tick', async () => {
      await page.goto(`${base.origin}/platform/schools/${restored!.id}`);
      await page.waitForSelector('#issue-principal-password');
      const btn = page.getByRole('button', { name: 'Issue principal password' });
      await btn.click(); // unticked: must refuse and change nothing
      await page.getByText(/Tick the box to confirm/).waitFor();
      const [p] = await q(`select password_hash from users where school_id = $1 and role = 'principal'`, [restored!.id]);
      assert.ok(String(p!.password_hash).startsWith('!restored-no-password!'), 'an unconfirmed click must not issue anything');
    });
    await check('PASSWORD: ticking and confirming shows the password ONCE, and it is never in the page address', async () => {
      await page.locator('#issue-principal-password input[type=checkbox]').check();
      await page.getByRole('button', { name: 'Issue principal password' }).click();
      const shown = page.getByTestId('temp-password'); await shown.waitFor();
      issuedPw = (await shown.innerText()).trim();
      assert.ok(issuedPw.length >= 12);
      assert.ok(!page.url().includes(issuedPw) && !decodeURIComponent(page.url()).includes(issuedPw), 'the password must never be in the URL');
    });
    await check('PASSWORD: the issued password really signs the restored principal in', async () => {
      const { verifyPassword } = await import('@/lib/auth/password');
      const [p] = await q(`select password_hash, must_change_password from users where school_id = $1 and role = 'principal'`, [restored!.id]);
      assert.equal(await verifyPassword(String(p!.password_hash), issuedPw), true);
      assert.equal(p!.must_change_password, true);
    });
    await check('PASSWORD: after "I have saved it" the password is gone from the page and the reloaded page', async () => {
      await page.getByRole('button', { name: 'I have saved it' }).click();
      assert.ok(!(await page.content()).includes(issuedPw));
      await page.reload(); await page.waitForSelector('#issue-principal-password');
      assert.ok(!(await page.content()).includes(issuedPw), 'the password must not survive a reload');
    });
    await check('PASSWORD: it is audited and the password is not in the audit log', async () => {
      const rows = await q(`select after from audit_log where school_id = $1 and action = 'school.principal_password_issued'`, [restored!.id]);
      assert.equal(rows.length, 1); assert.ok(!JSON.stringify(rows).includes(issuedPw));
    });
    await check('HELP: the guide exists at its real address, in the right category, and names the buttons that exist', async () => {
      const r = await page.goto(`${base.origin}/help/school-management/backup-and-restore-a-school`);
      assert.equal(r!.status(), 200);
      const text = await page.locator('main').innerText();
      for (const label of ['Download backup', 'Restore from backup', 'Upload and restore', 'Issue principal password', 'Send the signal again', 'Reset stalled restore']) assert.ok(text.includes(label), 'help article is missing: ' + label);
    });

    // ── 4. Refusals through the real HTTP layer ───────────────────────────
    await check('HTTP: a request with no session is refused with a clean 401, not a redirect page', async () => {
      const anon = await browser.newContext();
      const r = await anon.request.post(`${base.origin}/api/platform/school-backup/download/${sourceId}`, { headers: { origin: base.origin }, maxRedirects: 0 });
      assert.equal(r.status(), 401); assert.equal((await r.json()).ok, false);
      await anon.close();
    });
    await check('HTTP: a state-changing request from another origin is refused even with a valid session', async () => {
      const r = await context.request.post(`${base.origin}/api/platform/school-backup/download/${sourceId}`, { headers: { origin: 'https://evil.example' } });
      assert.equal(r.status(), 403); assert.equal((await r.json()).reason, 'bad_origin');
      const r2 = await context.request.post(`${base.origin}/api/platform/school-backup/download/${sourceId}`); // no Origin at all
      assert.equal(r2.status(), 403);
    });
    await check('HTTP: a school user\'s session cannot use the backup routes', async () => {
      const { token: t2 } = await createSession(Number(pu!.id), '127.0.0.1', 'backup-e2e');
      const ctx = await browser.newContext(); await ctx.addCookies([{ name: 'educbt.session', value: t2, url: base.origin }]);
      const r = await ctx.request.post(`${base.origin}/api/platform/school-backup/download/${sourceId}`, { headers: { origin: base.origin } });
      assert.equal(r.status(), 401); await ctx.close();
    });
    await check('HTTP: downloading a school that does not exist is a clean 404', async () => {
      const r = await context.request.post(`${base.origin}/api/platform/school-backup/download/99999999`, { headers: { origin: base.origin } });
      assert.equal(r.status(), 404);
    });
    await check('HTTP: a corrupt upload is refused at the finish step with a plain message', async () => {
      const junk = Buffer.from('x'.repeat(5000)); const { createHash } = await import('node:crypto');
      const start = await context.request.post(`${base.origin}/api/platform/school-backup/upload/start`, { headers: { origin: base.origin, 'content-type': 'application/json' },
        data: { fileName: 'junk.gz', totalBytes: junk.length, totalChunks: 1, sha256: createHash('sha256').update(Buffer.from('different')).digest('hex'), code: 'JJ' + suffix } });
      assert.equal(start.status(), 200); const { jobId } = await start.json();
      const put = await context.request.put(`${base.origin}/api/platform/school-backup/upload/${jobId}/chunk/0`, { headers: { origin: base.origin, 'content-type': 'application/octet-stream' }, data: junk });
      assert.equal(put.status(), 200);
      const fin = await context.request.post(`${base.origin}/api/platform/school-backup/upload/${jobId}/finish`, { headers: { origin: base.origin } });
      assert.ok(fin.status() >= 400 && fin.status() < 500); assert.match(JSON.stringify(await fin.json()), /checksum|damaged/i);
    });
    await check('no unexpected errors were logged in the browser console', () => assert.deepEqual(consoleErrors, [], consoleErrors.join(' | ')));

    console.log('\n' + count + ' checks passed.');
  } finally {
    await browser.close().catch(() => {});
    for (const id of schoolIds) await owner`delete from schools where id = ${id}`.catch(() => {});
    await owner`delete from school_backup_jobs where new_school_code like ${'%' + suffix}`.catch(() => {});
    await owner`delete from sessions where user_id = ${Number(admin!.id)}`.catch(() => {});
    await owner`delete from users where id = ${Number(admin!.id)}`.catch(() => {});
    await owner.end();
    writeFileSync(join(dir, 'done'), '1');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
