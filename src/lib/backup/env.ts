/**
 * Backup environment contract — validated before anything dangerous happens.
 *
 * Credential rules (README "Backups and disaster recovery" documents these):
 *  - The backup runs on a privileged/read-everything credential. RLS would
 *    make an `educbt_app` dump partial, so `BACKUP_DATABASE_URL` is an
 *    owner/admin credential — infrastructure only, never the app runtime,
 *    never committed, never logged.
 *  - The restore target is a SEPARATE database by construction: restoring
 *    into the live application database is refused outright, and non-local
 *    targets that do not look like rehearsal/staging require the explicit
 *    `--disaster-recovery` flag.
 */

import { parsePgUri, dbIdentity, PgUriError } from './pg-uri';

export interface StoreConfig {
  kind: 'r2' | 'local';
  /** R2 / S3-compatible */
  accessKeyId?: string;
  secretAccessKey?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  /** local dir fallback (dev / rehearsal) */
  localDir?: string;
}

export interface BackupEnv {
  /** Parsed BACKUP_DATABASE_URL (or, in dev only, DATABASE_URL_UNPOOLED). */
  sourceUri: ReturnType<typeof parsePgUri>;
  sourceLabel: string;
  store: StoreConfig;
  retentionDays: number;
}

export class BackupEnvError extends Error {}

const R2_KEYS = ['R2_BACKUP_ACCESS_KEY_ID', 'R2_BACKUP_SECRET_ACCESS_KEY', 'R2_BACKUP_BUCKET'] as const;
const R2_KEYS_OPTIONAL = ['R2_BACKUP_ACCOUNT_ID', 'R2_BACKUP_ENDPOINT', 'R2_BACKUP_REGION', 'R2_BACKUP_FORCE_PATH_STYLE'] as const;

export function readStoreConfig(env: Record<string, string | undefined>): StoreConfig {
  // R2 is configured only when ALL required keys are present — partial
  // configuration would silently fall back to local storage on a server,
  // which is worse than a clear failure.
  if (R2_KEYS.some((k) => env[k]?.trim())) {
    const missing = R2_KEYS.filter((k) => !env[k]?.trim());
    if (missing.length > 0) {
      throw new BackupEnvError(
        `R2 backup storage is partially configured — missing: ${missing.join(', ')}. ` +
        'Set all R2_BACKUP_* variables or none.',
      );
    }
    const accountId = env.R2_BACKUP_ACCOUNT_ID?.trim();
    const endpoint = env.R2_BACKUP_ENDPOINT?.trim() ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint) {
      throw new BackupEnvError('R2 backup storage needs R2_BACKUP_ENDPOINT or R2_BACKUP_ACCOUNT_ID.');
    }
    return {
      kind: 'r2',
      accessKeyId: env.R2_BACKUP_ACCESS_KEY_ID,
      secretAccessKey: env.R2_BACKUP_SECRET_ACCESS_KEY,
      bucket: env.R2_BACKUP_BUCKET,
      endpoint,
      region: env.R2_BACKUP_REGION?.trim() || 'auto',
      forcePathStyle: env.R2_BACKUP_FORCE_PATH_STYLE?.trim() === '1',
    };
  }
  const localDir = env.BACKUP_LOCAL_DIR?.trim();
  if (localDir) return { kind: 'local', localDir };
  throw new BackupEnvError(
    'No backup destination configured. Set the R2_BACKUP_* variables (production) ' +
    'or BACKUP_LOCAL_DIR (local/rehearsal). A backup with nowhere to go is not a backup.',
  );
}

export function readRetentionDays(env: Record<string, string | undefined>): number {
  const raw = env.BACKUP_RETENTION_DAYS?.trim();
  if (!raw) return 30;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1) {
    throw new BackupEnvError('BACKUP_RETENTION_DAYS must be an integer >= 1 (default 30).');
  }
  return days;
}

function readSourceUri(env: Record<string, string | undefined>): { uri: ReturnType<typeof parsePgUri>; label: string } {
  // Dev convenience: the unpooled owner credential already exists locally.
  // Production (and CI) sets BACKUP_DATABASE_URL explicitly.
  const explicit = env.BACKUP_DATABASE_URL?.trim();
  const fallback = env.DATABASE_URL_UNPOOLED?.trim();
  const label = explicit ? 'BACKUP_DATABASE_URL' : 'DATABASE_URL_UNPOOLED (dev fallback)';
  const raw = explicit || fallback;
  if (!raw) {
    throw new BackupEnvError(
      'BACKUP_DATABASE_URL is required (an owner/admin credential that can read the ' +
      'complete database despite RLS). Locally it falls back to DATABASE_URL_UNPOOLED.',
    );
  }
  const uri = parsePgUri(raw, label);
  // Refuse the least-privileged runtime ROLE: RLS would silently turn the
  // dump into a partial backup — exactly what this block forbids. Note the
  // backup legitimately targets the same *database* the app runs on; what
  // must never happen is backing up AS educbt_app (or with its exact URL).
  const appUrl = env.DATABASE_URL_APP?.trim();
  const asAppRole =
    uri.user === 'educbt_app' ||
    (appUrl && appUrl === raw);
  if (asAppRole) {
    throw new BackupEnvError(
      `Refusing to back up with ${label}: that is the RLS-restricted application ` +
      'credential. A backup must use a privileged, non-runtime credential (owner/admin role).',
    );
  }
  return { uri, label };
}

export function readBackupEnv(env: Record<string, string | undefined> = process.env): BackupEnv {
  const { uri, label } = readSourceUri(env);
  return { sourceUri: uri, sourceLabel: label, store: readStoreConfig(env), retentionDays: readRetentionDays(env) };
}

// ─── Restore target safety ─────────────────────────────────────────────────

const REHEARSAL_DBNAME = /(rehearsal|restore|staging|scratch|temp|test)/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * The restore target must be a *different* database from everything live:
 *  - NEVER the database the application runtime uses, even with
 *    --disaster-recovery — DR restores into a fresh database, then the app's
 *    DATABASE_URL_APP is repointed. This guard is not overridable because a
 *    restore into the live app database is the one mistake the whole design
 *    exists to prevent.
 *  - NEVER the backup source database.
 *  - Without --disaster-recovery, the target must look non-production:
 *    a local host or a database name that says what it is
 *    (rehearsal/restore/staging/test/...).
 */
export function assertSafeRestoreTarget(
  targetUrl: string | undefined,
  env: Record<string, string | undefined> = process.env,
  opts: { disasterRecovery: boolean },
): ReturnType<typeof parsePgUri> {
  const uri = parsePgUri(targetUrl, 'RESTORE_DATABASE_URL');
  const identity = `${uri.host}:${uri.port}/${uri.dbname}`;

  const liveTargets = [
    ['DATABASE_URL_APP', env.DATABASE_URL_APP?.trim()],
    ['BACKUP_DATABASE_URL', env.BACKUP_DATABASE_URL?.trim() ?? env.DATABASE_URL_UNPOOLED?.trim()],
  ] as const;
  for (const [name, url] of liveTargets) {
    if (url && dbIdentity(url) === identity) {
      throw new PgUriError(
        `Refusing to restore into the ${name} database (${identity}). ` +
        'Restore into a separate database, then repoint the application if this is disaster recovery.',
      );
    }
  }

  if (!opts.disasterRecovery) {
    const localHost = LOCAL_HOSTS.has(uri.host.toLowerCase());
    const looksLikeRehearsal = REHEARSAL_DBNAME.test(uri.dbname);
    if (!localHost && !looksLikeRehearsal) {
      throw new PgUriError(
        `Refusing non-local target ${identity}: it does not look like a rehearsal/staging database. ` +
        'Pass --disaster-recovery only for a deliberate recovery into a fresh, dedicated database.',
      );
    }
  }
  return uri;
}
