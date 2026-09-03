/**
 * scripts/backup-database.ts — full database backup → object storage.
 *
 * Usage:
 *   npm run backup:db
 *   BACKUP_DATABASE_URL=... R2_BACKUP_* ... npm run backup:db
 *
 * Pipeline (each step must succeed before the next runs; nothing is
 * swallowed):
 *   1. validate the environment (privileged source URL, store config,
 *      retention days)
 *   2. allocate a deterministic UTC backup id (collision-safe)
 *   3. pg_dump -Fc to a temporary file
 *   4. verify the file exists and is non-zero
 *   5. `pg_restore --list` — the archive is parseable and contains objects
 *   6. upload to the configured store (R2 in production)
 *   7. confirm the upload: object exists, size matches exactly
 *   8. remove the temporary file
 *   9. ONLY THEN run age-based retention cleanup, confined to the
 *      backups/database/ prefix
 *  10. print a structured JSON summary; exit 0 on success, non-zero on any
 *      failure.
 *
 * A failed upload is a failed backup. Retention never runs after a failure.
 */

import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBackupEnv, BackupEnvError } from '../src/lib/backup/env';
import { backupId, nextAvailableId } from '../src/lib/backup/naming';
import { selectRetention } from '../src/lib/backup/retention';
import { storeFromConfig, keyFor, idFromKey } from '../src/lib/backup/store';
import { describePgUri } from '../src/lib/backup/pg-uri';
import { pgDumpArgs, pgRestoreListArgs, runPgTool } from '../src/lib/backup/pg-commands';
import { PgUriError } from '../src/lib/backup/pg-uri';

function fail(message: string, extra?: Record<string, unknown>): never {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  process.exit(1);
}

async function main() {
  const startedAt = new Date();
  let env;
  try {
    env = readBackupEnv();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const store = storeFromConfig(env.store);
  // Logged: connection identity WITHOUT credentials.
  console.error(`INFO  source: ${describePgUri(process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED)}`);
  console.error(`INFO  store:  ${store.kind}${store.kind === 'r2' ? '' : ` (${env.store.localDir})`}`);

  // 1—2: deterministic, collision-safe id. Two near-simultaneous runs get
  // distinct ids; nothing already stored is ever overwritten.
  const id = await nextAvailableId(backupId(startedAt), (candidate) => store.exists(candidate));
  const key = keyFor(id);
  const tmpFile = join(tmpdir(), `${id}.dump`);

  try {
    // 3: pg_dump (custom format).
    const dump = await runPgTool('pg_dump', pgDumpArgs(env.sourceUri, tmpFile), env.sourceUri);
    if (dump.code !== 0) {
      fail('pg_dump failed', { backupId: id, pgExitCode: dump.code, pgStderr: dump.stderr });
    }

    // 4: exists and non-zero.
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(tmpFile)).size;
    } catch {
      fail('pg_dump reported success but the backup file does not exist', { backupId: id });
    }
    if (sizeBytes === 0) fail('backup file is empty (0 bytes) — refusing to upload', { backupId: id });

    // 5: archive integrity — the custom-format archive lists without a DB.
    const list = await runPgTool('pg_restore', pgRestoreListArgs(tmpFile), env.sourceUri, { maxStderrChars: 2000 });
    const objectCount = list.stdout.split('\n').filter((l) => / (TABLE|DATABASE|SEQUENCE|FK|INDEX|CONSTRAINT) /i.test(l)).length;
    if (list.code !== 0 || objectCount === 0) {
      fail('backup archive failed the pg_restore --list integrity check', { backupId: id, pgExitCode: list.code, archiveObjects: objectCount });
    }

    // 6—7: upload and CONFIRM it (existence + exact byte-size match).
    const put = await store.put(id, tmpFile);
    const remoteSize = await store.size(id);
    if (remoteSize === null || remoteSize !== sizeBytes) {
      // A failed upload is a failed backup — never reported as success.
      fail('upload confirmation failed (object missing or size mismatch)', {
        backupId: id,
        localBytes: sizeBytes,
        remoteBytes: remoteSize,
      });
    }

    // 8: no temp files accumulate anywhere (local dev box or CI runner).
    await rm(tmpFile, { force: true });

    // 9: retention cleanup — only after a fully confirmed backup, only
    // inside the backup prefix, only objects our own naming produced.
    const allKeys = await store.list();
    const selection = selectRetention(allKeys, env.retentionDays, startedAt);
    const deleted: string[] = [];
    for (const k of selection.expired) {
      await store.delete(idFromKey(k));
      deleted.push(k);
    }

    const finishedAt = new Date();
    console.log(
      JSON.stringify(
        {
          ok: true,
          backupId: id,
          key,
          store: store.kind,
          sizeBytes,
          archiveObjects: objectCount,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 100) / 10,
          integrity: 'pg_restore --list OK',
          retention: {
            days: env.retentionDays,
            considered: allKeys.length,
            retained: selection.retained.length,
            deleted: deleted.length,
            // Foreign objects are REPORTED, never touched.
            foreignInPrefix: selection.foreign.length,
          },
        },
        null, 2,
      ),
    );
  } catch (err) {
    await rm(tmpFile, { force: true }); // never leave a partial dump behind
    fail(err instanceof Error ? err.message : String(err), { backupId: id });
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
