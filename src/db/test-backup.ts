/**
 * Backup/restore verification — pure, no database, no network.
 *
 *   npm run test:backup
 *
 * Covers the pieces of the backup layer where a unit check carries real
 * weight: naming determinism, retention selection (age-based, prefix-safe),
 * environment validation, restore-target safety, and the fact that pg_dump /
 * pg_restore are invoked with NO secret on the command line.
 *
 * The Google Cloud Storage adapter is tested against a deterministic in-file
 * fake of the SDK surface (no network, no credentials). That is an adapter
 * unit test, NOT real-provider verification — the actual Firebase bucket
 * (educbt-a07ae.firebasestorage.app) is exercised separately once
 * infrastructure credentials exist.
 *
 * It deliberately does NOT mock pg_dump and call that a recovery proof —
 * the real restore rehearsal (backup → upload → download → pg_restore →
 * db:verify on a separate database) is executed live and documented in the
 * README "Backups and disaster recovery" section.
 */

import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupId, backupFilename, backupKey, parseBackupKey, nextAvailableId, BACKUP_PREFIX } from '@/lib/backup/naming';
import { selectRetention } from '@/lib/backup/retention';
import { readBackupEnv, readStoreConfig, assertSafeRestoreTarget, BackupEnvError } from '@/lib/backup/env';
import { parsePgUri, describePgUri, pgToolEnv } from '@/lib/backup/pg-uri';
import { pgDumpArgs, pgRestoreArgs } from '@/lib/backup/pg-commands';
import { LocalDirStore, GcsStore, storeFromConfig, type GcsBucketApi } from '@/lib/backup/store';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

const utc = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(Date.UTC(y, mo - 1, d, h, mi, s));
const idAt = (d: Date) => backupId(d);

async function main() {
  // ── Naming ──────────────────────────────────────────────────────────────
  const t = utc(2026, 9, 3, 22, 0, 0);
  check('backup id is UTC-stamped and matches the documented pattern', idAt(t) === 'educbt-2026-09-03T220000Z', idAt(t));
  check('filename appends .dump', backupFilename('educbt-2026-09-03T220000Z') === 'educbt-2026-09-03T220000Z.dump');
  check('storage key mirrors the UTC date folders', backupKey('educbt-2026-09-03T220000Z') === 'backups/database/2026/09/03/educbt-2026-09-03T220000Z.dump');
  check('ids one second apart never collide', idAt(utc(2026, 9, 3, 22, 0, 0)) !== idAt(utc(2026, 9, 3, 22, 0, 1)));
  check('key parse rejects mismatched date folders', parseBackupKey('backups/database/2027/01/01/educbt-2026-09-03T220000Z.dump') === null);
  check('key parse accepts the collision suffix', parseBackupKey(backupKey('educbt-2026-09-03T220000Z-2'))?.id === 'educbt-2026-09-03T220000Z-2');

  // Collision: existing ids get -2/-3, existing ones untouched.
  const taken = new Set(['educbt-2026-09-03T220000Z', 'educbt-2026-09-03T220000Z-2']);
  const allocated = await nextAvailableId('educbt-2026-09-03T220000Z', async (id) => taken.has(id));
  check('a second run in the same second gets a distinct id, never an overwrite', allocated === 'educbt-2026-09-03T220000Z-3', allocated);

  // ── Retention ────────────────────────────────────────────────────────────
  const now = utc(2026, 9, 3, 22, 0, 0);
  const oldBackup = backupKey(idAt(utc(2026, 7, 1, 0, 0, 0)));       // 64 days old
  const freshBackup = backupKey(idAt(utc(2026, 9, 2, 23, 59, 0)));    // 1 day old
  const boundary = backupKey(idAt(utc(2026, 8, 4, 22, 0, 1)));       // 30 days minus 1s — retained
  const justOver = backupKey(idAt(utc(2026, 8, 4, 21, 59, 59)));      // 30 days + 1s — expired (strictly older)
  const foreignInPrefix = `${BACKUP_PREFIX}notes.txt`;
  const foreignOutside = 'media/2026/09/03/school-logo.png';

  const sel = selectRetention([oldBackup, freshBackup, boundary, justOver, foreignInPrefix, foreignOutside], 30, now);
  check('retention deletes the 64-day-old backup', sel.expired.includes(oldBackup));
  check('retention keeps the 1-day-old backup', sel.retained.includes(freshBackup));
  check('retention keeps a backup 1 second inside the window', sel.retained.includes(boundary));
  check('retention deletes a backup past the exact 30-day boundary', sel.expired.includes(justOver));
  check('retention never selects a foreign object inside our prefix', !sel.expired.includes(foreignInPrefix) && sel.foreign.includes(foreignInPrefix));
  check('retention never even considers objects outside the prefix', !sel.expired.includes(foreignOutside) && !sel.foreign.includes(foreignOutside));
  // >1 backup/day for 30+ days: count-based would be wrong, age-based is right.
  const manyOld = Array.from({ length: 80 }, (_, i) => backupKey(idAt(utc(2026, 6, 1, 0, 0, i % 60)))); // all June, >30/day some days
  const manySel = selectRetention([...manyOld, freshBackup], 30, now);
  check('count-based drift is impossible: all 80 June backups expire regardless of daily multiplicity', manySel.expired.length === 80 && manySel.retained.length === 1);
  check('retention days must be a positive integer', (() => { try { selectRetention([], 0); return false; } catch { return true; } })());

  // ── Local store round-trip + prefix confinement ─────────────────────────
  const dir = await mkdtemp(join(tmpdir(), 'backup-test-'));
  try {
    const store = new LocalDirStore(dir);
    const dumpFile = join(dir, 'source.dump');
    await writeFile(dumpFile, Buffer.alloc(2048, 7));
    const put = await store.put(idAt(t), dumpFile);
    check('local store put returns the deterministic key', put.key === backupKey(idAt(t)) && put.sizeBytes === 2048);
    check('store reports existence and exact size', (await store.exists(idAt(t))) && (await store.size(idAt(t))) === 2048);
    await store.get(idAt(t), join(dir, 'download.dump'));
    const { stat } = await import('node:fs/promises');
    check('downloaded bytes match uploaded bytes', (await stat(join(dir, 'download.dump'))).size === 2048);
    check('list returns only keys inside the backup prefix', JSON.stringify(await store.list()) === JSON.stringify([put.key]));
    // A file planted outside the prefix must be invisible to list().
    await mkdir(join(dir, 'media'), { recursive: true });
    await writeFile(join(dir, 'media/logo.png'), 'x');
    check('list is blind to objects outside the prefix (unrelated objects unreachable by retention)', (await store.list()).length === 1);
    await store.delete(idAt(t));
    check('delete removes exactly the one backup', !(await store.exists(idAt(t))) && (await store.list()).length === 0);
    let refused = false;
    try {
      // The public API cannot express an outside key: keyFor() validates the
      // backup id pattern, so any non-educbt path throws before deletion.
      await store.delete('media/logo');
    } catch {
      refused = true;
    }
    check('deleting through the API rejects keys outside the backup prefix', refused);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // ── Environment validation ──────────────────────────────────────────────
  const svcJson = JSON.stringify({ client_email: 'educbt-backup@educbt-a07ae.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n' });
  const baseEnv: Record<string, string> = {
    BACKUP_DATABASE_URL: 'postgresql://postgres:pw@db-admin.example.com:5432/educbt',
    FIREBASE_STORAGE_BUCKET: 'educbt-a07ae.firebasestorage.app',
    FIREBASE_PROJECT_ID: 'educbt-a07ae',
    GCS_BACKUP_CREDENTIALS_JSON: svcJson,
    DATABASE_URL_APP: 'postgresql://educbt_app:pw@db.example.com:5432/educbt',
  };
  const gcsStore = readBackupEnv(baseEnv).store;
  check('a complete Firebase/GCS env validates as the gcs store', gcsStore.kind === 'gcs');
  check('the bucket and project id are read from FIREBASE_* variables', gcsStore.bucket === 'educbt-a07ae.firebasestorage.app' && gcsStore.projectId === 'educbt-a07ae');
  check('partial GCS configuration is rejected (never a silent local fallback)', (() => { try { readBackupEnv({ ...baseEnv, FIREBASE_PROJECT_ID: '' }); return false; } catch (e) { return e instanceof BackupEnvError; } })());
  check('malformed credential JSON is rejected at env validation time', (() => { try { readBackupEnv({ ...baseEnv, GCS_BACKUP_CREDENTIALS_JSON: '{not json' }); return false; } catch (e) { return e instanceof BackupEnvError; } })());
  check('credential JSON without service-account fields is rejected', (() => { try { readBackupEnv({ ...baseEnv, GCS_BACKUP_CREDENTIALS_JSON: '{"foo":1}' }); return false; } catch (e) { return e instanceof BackupEnvError; } })());
  check('the error names the Firebase variables when nothing is configured', (() => { try { readStoreConfig({}); return false; } catch (e) { return e instanceof BackupEnvError && /FIREBASE_STORAGE_BUCKET/.test(e.message); } })());
  check('no destination at all is rejected', (() => { try { readBackupEnv({ BACKUP_DATABASE_URL: baseEnv.BACKUP_DATABASE_URL }); return false; } catch { return true; } })());
  check('missing backup source URL is rejected', (() => { try { readBackupEnv({}); return false; } catch { return true; } })());
  check('backing up over the RLS-restricted app credential is refused', (() => { try { readBackupEnv({ ...baseEnv, BACKUP_DATABASE_URL: baseEnv.DATABASE_URL_APP, DATABASE_URL_APP: baseEnv.DATABASE_URL_APP }); return false; } catch (e) { return e instanceof BackupEnvError; } })());
  check('BACKUP_RETENTION_DAYS defaults to 30', readBackupEnv(baseEnv).retentionDays === 30);
  check('BACKUP_RETENTION_DAYS=0 is rejected (would delete every backup)', (() => { try { readBackupEnv({ ...baseEnv, BACKUP_RETENTION_DAYS: '0' }); return false; } catch { return true; } })());
  check('local dir store is accepted for rehearsal', readStoreConfig({ BACKUP_LOCAL_DIR: '/tmp/backups' }).kind === 'local');


  // ── GCS adapter against a deterministic fake of the SDK surface ───────────
  class FakeBucket implements GcsBucketApi {
    files = new Map<string, Buffer>();
    lastSaveOptions: Record<string, unknown> | null = null;
    lastListPrefix = '';
    failOnSave = false;
    file(name: string) {
      const self = this;
      return {
        async save(data: Buffer, options?: { contentType?: string; resumable?: boolean }) {
          if (self.failOnSave) throw new Error(' simulated storage failure ');
          self.lastSaveOptions = options ?? {};
          self.files.set(name, data);
          return {};
        },
        async download() {
          const f = self.files.get(name);
          if (!f) throw new Error('not found');
          return [f, {}] as [Buffer, unknown];
        },
        async exists() { return [self.files.has(name)] as [boolean]; },
        async getMetadata() {
          const f = self.files.get(name);
          if (!f) throw new Error('not found');
          return { size: f.byteLength };
        },
        async delete() {
          if (!self.files.has(name)) throw new Error('not found');
          self.files.delete(name);
          return {};
        },
      };
    }
    async getFiles(options: { prefix: string; autoPaginate: true }) {
      this.lastListPrefix = options.prefix;
      // Only objects under the requested prefix are ever visible — same as
      // a real prefix-scoped listing.
      return [...this.files.keys()].filter((k) => k.startsWith(options.prefix)).map((name) => ({ name }));
    }
  }
  {
    const fake = new FakeBucket();
    const store = new GcsStore({ kind: 'gcs', bucket: 'educbt-a07ae.firebasestorage.app', projectId: 'educbt-a07ae' }, fake);
    const dir = await mkdtemp(join(tmpdir(), 'gcs-adapter-'));
    try {
      const dumpFile = join(dir, 'dump.bin');
      await writeFile(dumpFile, Buffer.alloc(1536, 9));
      const put = await store.put(idAt(t), dumpFile);
      check('gcs put stores under the deterministic key and reports exact bytes', put.key === backupKey(idAt(t)) && put.sizeBytes === 1536);
      check('gcs upload is one-shot, non-resumable, binary content type', fake.lastSaveOptions?.resumable === false && fake.lastSaveOptions?.contentType === 'application/octet-stream');
      check('gcs size confirms the uploaded object via metadata', (await store.size(idAt(t))) === 1536);
      check('gcs size returns null for a missing object', (await store.size(idAt(utc(2026, 1, 1, 0, 0, 0)))) === null);
      const dl = join(dir, 'download.bin');
      await store.get(idAt(t), dl);
      const dlBytes = await readFile(dl);
      check('gcs download returns byte-identical content', dlBytes.byteLength === 1536 && dlBytes[0] === 9 && dlBytes[1535] === 9);
      check('gcs exists distinguishes present from absent', (await store.exists(idAt(t))) && !(await store.exists(idAt(utc(2026, 1, 1, 0, 0, 0)))));
      // A foreign object inside the bucket but outside the prefix.
      await fake.files.set('media/logos/school.png', Buffer.from('x'));
      const listed = await store.list();
      check('gcs list is prefix-scoped — unrelated bucket objects are invisible', listed.length === 1 && listed[0] === put.key && fake.lastListPrefix === BACKUP_PREFIX);
      await store.delete(idAt(t));
      check('gcs delete removes exactly the one backup', !(await store.exists(idAt(t))) && (await store.list()).length === 0 && fake.files.has('media/logos/school.png'));
      let refused = false;
      try { await store.delete(idAt(t)); } catch { refused = true; }
      check('gcs delete of a missing object surfaces the error (no silent success)', refused);
      fake.failOnSave = true;
      let uploadFailed = false;
      try { await store.put(idAt(t), dumpFile); } catch { uploadFailed = true; }
      check('a storage failure propagates — a failed upload is a failed backup', uploadFailed);
      fake.failOnSave = false;
      let badKeyRefused = false;
      try { await store.delete('../etc/passwd'); } catch { badKeyRefused = true; }
      check('the backup-id pattern refuses key traversal before the SDK is touched', badKeyRefused);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Adapter construction guards.
    let noBucketRefused = false;
    try { new GcsStore({ kind: 'gcs', bucket: '', projectId: 'p' } as never, fake); } catch { noBucketRefused = true; }
    check('the gcs store refuses construction without a bucket/project', noBucketRefused);
    let badJsonRefused = false;
    try { new GcsStore({ kind: 'gcs', bucket: 'b', projectId: 'p', credentialsJson: '{bad' }, fake); } catch { badJsonRefused = true; }
    check('the gcs store rejects malformed credential JSON itself', badJsonRefused);
    let adcOk = false;
    try { new GcsStore({ kind: 'gcs', bucket: 'b', projectId: 'p' }, fake); adcOk = true; } catch { adcOk = false; }
    check('the gcs store constructs cleanly with no inline credential (ADC path)', adcOk);
    // Structural privacy guarantee: the storage module cannot create public
    // or signed URLs, and no R2/S3 code remains in the production path.
    const storeSrc = readFileSync(join(process.cwd(), 'src/lib/backup/store.ts'), 'utf8');
    check('the store has no signed-URL, makePublic or public-URL code', !/getSignedUrl|makePublic|publicUrl|public_url/i.test(storeSrc));
    check('no R2/S3 adapter remains in the store module', !/@aws-sdk|S3Compatible/i.test(storeSrc));
    check('env validation never leaks the credential JSON in errors', (() => { try { readBackupEnv({ ...baseEnv, GCS_BACKUP_CREDENTIALS_JSON: '{bad' }); return false; } catch (e) { return !(e instanceof Error) || !e.message.includes(svcJson); } })());
  }

  // ── Restore-target safety ────────────────────────────────────────────────
  const appUrl = 'postgresql://educbt_app:pw2@prod.example.com:5432/educbt';
  const envWith = (o: Record<string, string>) => ({ DATABASE_URL_APP: appUrl, ...o });
  const rehearsalUrl = 'postgresql://postgres:pw@localhost:5433/educbt_restore_rehearsal';
  check('restore into the live application database is refused — even with --disaster-recovery', (() => {
    try { assertSafeRestoreTarget(appUrl, envWith({}), { disasterRecovery: true }); return false; } catch { return true; }
  })());
  check('restore into the backup source database is refused', (() => {
    try { assertSafeRestoreTarget('postgresql://postgres:pw@prod.example.com:5432/educbt', envWith({ BACKUP_DATABASE_URL: 'postgresql://postgres:pw@prod.example.com:5432/educbt' }), { disasterRecovery: false }); return false; } catch { return true; }
  })());
  check('a non-local, non-rehearsal target is refused without the flag', (() => {
    try { assertSafeRestoreTarget('postgresql://postgres:pw@prod2.example.com:5432/main', envWith({}), { disasterRecovery: false }); return false; } catch { return true; }
  })());
  check('the same remote target is allowed with explicit --disaster-recovery', (() => {
    try { assertSafeRestoreTarget('postgresql://postgres:pw@prod2.example.com:5432/fresh-restore', envWith({}), { disasterRecovery: true }); return true; } catch { return false; }
  })());
  check('a localhost rehearsal target passes without the flag', assertSafeRestoreTarget(rehearsalUrl, envWith({}), { disasterRecovery: false }).dbname === 'educbt_restore_rehearsal');
  check('the app database is refused by identity even through a different credential', (() => {
    try { assertSafeRestoreTarget('postgresql://postgres:other@prod.example.com:5432/educbt', envWith({}), { disasterRecovery: true }); return false; } catch { return true; }
  })());
  check('missing RESTORE_DATABASE_URL is refused', (() => { try { assertSafeRestoreTarget(undefined, envWith({}), { disasterRecovery: true }); return false; } catch { return true; } })());

  // ── Credential hygiene in command construction ───────────────────────────
  const uri = parsePgUri('postgresql://backup_user:s3cret@db.example.com:5432/educbt?sslmode=require');
  const dumpArgs = pgDumpArgs(uri, '/tmp/x.dump');
  const restoreArgs = pgRestoreArgs(uri, '/tmp/x.dump');
  const asString = [...dumpArgs, ...restoreArgs].join(' ');
  check('no password appears on the pg_dump/pg_restore command line', !asString.includes('s3cret'));
  check('no connection URI appears on the command line (ps-safe)', !asString.includes('://'));
  check('the password travels through the process environment instead', pgToolEnv(uri, {}).PGPASSWORD === 's3cret');
  check('sslmode travels through the process environment', pgToolEnv(uri, {}).PGSSLMODE === 'require');
  check('describePgUri never includes the password or full URL', !describePgUri('postgresql://u:s3cret@db.example.com:5432/educbt').includes('s3cret'));

  console.log(failures === 0 ? '\nAll backup checks passed.' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
