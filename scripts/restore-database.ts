/**
 * scripts/restore-database.ts — restore a backup into a SEPARATE database.
 *
 * Usage:
 *   npm run restore:db -- --list
 *   RESTORE_DATABASE_URL=... npm run restore:db -- --backup educbt-2026-09-03T220000Z
 *   # deliberate disaster recovery (fresh, dedicated database only):
 *   RESTORE_DATABASE_URL=... npm run restore:db -- --backup <id> --disaster-recovery
 *
 * Safety model:
 *  - RESTORE_DATABASE_URL is REQUIRED — there is no default target, ever.
 *  - A target that is the live application database (DATABASE_URL_APP) or
 *    the backup source is refused outright, flag or no flag.
 *  - Without --disaster-recovery the target must be local or obviously a
 *    rehearsal/staging database. One typo cannot reach production.
 *  - pg_restore runs WITHOUT --clean: the target must be an EMPTY database.
 *    Restoring over existing objects fails loudly instead of dropping.
 *
 * After restore, the script connects to the target and verifies the schema
 * actually arrived (relations, migrations bookkeeping, row counts) and
 * prints a structured summary.
 */

import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { assertSafeRestoreTarget } from '../src/lib/backup/env';
import { assertValidBackupId, BACKUP_KEY_PATTERN } from '../src/lib/backup/naming';
import { keyFor, idFromKey, storeFromConfig } from '../src/lib/backup/store';
import { readStoreConfig, BackupEnvError } from '../src/lib/backup/env';
import { pgRestoreArgs, pgRestoreListArgs, runPgTool } from '../src/lib/backup/pg-commands';
import { describePgUri } from '../src/lib/backup/pg-uri';

function fail(message: string, extra?: Record<string, unknown>): never {
  console.log(JSON.stringify({ ok: false, error: message, ...extra }));
  process.exit(1);
}

function parseArgs(argv: string[]): { list: boolean; backup?: string; disasterRecovery: boolean } {
  const out = { list: false, disasterRecovery: false } as { list: boolean; backup?: string; disasterRecovery: boolean };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--list') out.list = true;
    else if (a === '--disaster-recovery') out.disasterRecovery = true;
    else if (a === '--backup') out.backup = argv[++i];
    else fail(`unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The store configuration (GCS/Firebase or local) is validated by the same code the
  // backup script uses — one contract, one validator.
  let store;
  try {
    store = storeFromConfig(readStoreConfig(process.env));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (args.list) {
    const keys = await store.list();
    // Only valid, parseable backups are selectable. Foreign objects in the
    // prefix are reported separately and are never offered for restore.
    const backups = keys.filter((k) => BACKUP_KEY_PATTERN.test(k));
    const foreign = keys.filter((k) => !BACKUP_KEY_PATTERN.test(k));
    const rows = backups
      .map((k) => {
        const m = BACKUP_KEY_PATTERN.exec(k)!;
        return { backupId: idFromKey(k), key: k, takenAtUtc: `${m[1]}-${m[2]}-${m[3]}` };
      })
      .sort((a, b) => (a.backupId < b.backupId ? 1 : -1));
    console.log(JSON.stringify({ ok: true, store: store.kind, count: rows.length, foreignObjectsInPrefix: foreign.length, backups: rows }, null, 2));
    return;
  }

  if (!args.backup) {
    fail('select a backup with --backup <id> (see --list), or --list to enumerate.');
  }
  let backupId = args.backup;
  if (!BACKUP_KEY_PATTERN.test(backupId)) {
    // Accept the full key as well as the bare id.
    if (backupId.includes('/')) backupId = idFromKey(backupId);
    try {
      assertValidBackupId(backupId);
    } catch {
      fail(`not a valid backup id: ${args.backup}`);
    }
  }

  // Safety guard FIRST — before any download or restore happens.
  let target;
  try {
    target = assertSafeRestoreTarget(process.env.RESTORE_DATABASE_URL, process.env, {
      disasterRecovery: args.disasterRecovery,
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  console.error(`INFO  target: ${describePgUri(process.env.RESTORE_DATABASE_URL)}${args.disasterRecovery ? ' (--disaster-recovery)' : ''}`);

  if (!(await store.exists(backupId))) {
    const keys = await store.list();
    fail(`backup ${backupId} not found in ${store.kind} store`, { available: keys.map(idFromKey).sort().reverse() });
  }

  // 1. Download to a temp file (never assume persistent disk).
  const tmpFile = join(tmpdir(), `${backupId}.restore.download`);
  await store.get(backupId, tmpFile);
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(tmpFile)).size;
  } catch {
    fail('downloaded backup file missing', { backupId });
  }
  if (sizeBytes === 0) fail('downloaded backup file is empty (0 bytes)', { backupId });

  // 2. Integrity check BEFORE restoring — a corrupt archive must never
  // reach a database.
  const list = await runPgTool('pg_restore', pgRestoreListArgs(tmpFile), target, { maxStderrChars: 2000 });
  const archiveObjects = list.stdout.split('\n').filter((l) => / (TABLE|DATABASE|SEQUENCE|FK|INDEX|CONSTRAINT) /i.test(l)).length;
  if (list.code !== 0 || archiveObjects === 0) {
    await rm(tmpFile, { force: true });
    fail('archive failed the pg_restore --list integrity check — not restored', { backupId, archiveObjects });
  }

  // 3. pg_restore into the (empty, separate) target database.
  const restored = await runPgTool('pg_restore', pgRestoreArgs(target, tmpFile), target);
  await rm(tmpFile, { force: true });
  // pg_restore exits non-zero on real failure. Missing-role ACL warnings
  // (role educbt_app does not exist yet) are warnings, not failures — the
  // recovery runbook provisions the role and re-applies grants after this.
  if (restored.code !== 0) {
    fail('pg_restore failed', { backupId, pgExitCode: restored.code, pgStderr: restored.stderr });
  }

  // 4. Post-restore verification against the restored database itself.
  const sql = postgres(process.env.RESTORE_DATABASE_URL!, { max: 1 });
  try {
    const rel = await sql`select count(*)::int as relations from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'`;
    const mig = await sql`select count(*)::int as applied from drizzle.__drizzle_migrations`;
    const counts = await sql`
      select
        (select count(*)::int from public.schools) as schools,
        (select count(*)::int from public.users) as users,
        (select count(*)::int from public.audit_log) as audit_log,
        (select count(*)::int from public.questions) as questions,
        (select count(*)::int from public.exam_papers) as exam_papers,
        (select count(*)::int from public.students) as students`;
    const policies = await sql`select count(*)::int as n from pg_policies where schemaname = 'public'`;
    const rlsForced = await sql`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and c.relforcerowsecurity`;
    console.log(
      JSON.stringify(
        {
          ok: true,
          backupId,
          key: keyFor(backupId),
          restoredBytes: sizeBytes,
          archiveObjects,
          verification: {
            publicRelations: rel[0]!.relations,
            appliedMigrations: mig[0]!.applied,
            schools: counts[0]!.schools,
            users: counts[0]!.users,
            auditLog: counts[0]!.audit_log,
            questions: counts[0]!.questions,
            examPapers: counts[0]!.exam_papers,
            students: counts[0]!.students,
            rlsPolicies: policies[0]!.n,
            rlsForcedTables: rlsForced[0]!.n,
          },
        },
        null, 2,
      ),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
