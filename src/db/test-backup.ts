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
 * It deliberately does NOT mock pg_dump and call that a recovery proof —
 * the real restore rehearsal (backup → upload → download → pg_restore →
 * db:verify on a separate database) is executed live and documented in the
 * README "Backups and disaster recovery" section.
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupId, backupFilename, backupKey, parseBackupKey, nextAvailableId, BACKUP_PREFIX } from '@/lib/backup/naming';
import { selectRetention } from '@/lib/backup/retention';
import { readBackupEnv, readStoreConfig, assertSafeRestoreTarget, BackupEnvError } from '@/lib/backup/env';
import { parsePgUri, describePgUri, pgToolEnv } from '@/lib/backup/pg-uri';
import { pgDumpArgs, pgRestoreArgs } from '@/lib/backup/pg-commands';
import { LocalDirStore, storeFromConfig } from '@/lib/backup/store';

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
  const baseEnv: Record<string, string> = {
    BACKUP_DATABASE_URL: 'postgresql://postgres:pw@db-admin.example.com:5432/educbt',
    R2_BACKUP_ACCESS_KEY_ID: 'k',
    R2_BACKUP_SECRET_ACCESS_KEY: 's',
    R2_BACKUP_BUCKET: 'educbt-backups',
    R2_BACKUP_ACCOUNT_ID: 'acc',
    DATABASE_URL_APP: 'postgresql://educbt_app:pw@db.example.com:5432/educbt',
  };
  check('a complete R2 env validates', readBackupEnv(baseEnv).store.kind === 'r2');
  check('R2 endpoint is derived from the account id', readBackupEnv(baseEnv).store.endpoint === 'https://acc.r2.cloudflarestorage.com');
  check('partial R2 configuration is rejected (never a silent local fallback)', (() => { try { readBackupEnv({ ...baseEnv, R2_BACKUP_BUCKET: '' }); return false; } catch (e) { return e instanceof BackupEnvError; } })());
  check('no destination at all is rejected', (() => { try { readBackupEnv({ BACKUP_DATABASE_URL: baseEnv.BACKUP_DATABASE_URL }); return false; } catch { return true; } })());
  check('missing backup source URL is rejected', (() => { try { readBackupEnv({}); return false; } catch { return true; } })());
  check('backing up over the RLS-restricted app credential is refused', (() => { try { readBackupEnv({ ...baseEnv, BACKUP_DATABASE_URL: baseEnv.DATABASE_URL_APP, DATABASE_URL_APP: baseEnv.DATABASE_URL_APP }); return false; } catch (e) { return e instanceof BackupEnvError; } })());
  check('BACKUP_RETENTION_DAYS defaults to 30', readBackupEnv(baseEnv).retentionDays === 30);
  check('BACKUP_RETENTION_DAYS=0 is rejected (would delete every backup)', (() => { try { readBackupEnv({ ...baseEnv, BACKUP_RETENTION_DAYS: '0' }); return false; } catch { return true; } })());
  check('local dir store is accepted for rehearsal', readStoreConfig({ BACKUP_LOCAL_DIR: '/tmp/backups' }).kind === 'local');

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
