/**
 * Deterministic backup naming.
 *
 * Backup ids are UTC-ISO-timestamped (`educbt-2026-09-03T220000Z`), file names
 * append `.dump`, and the storage key mirrors the date so a bucket listing is
 * chronological on its own:
 *
 *   backups/database/YYYY/MM/DD/educbt-YYYY-MM-DDTHHMMSSZ.dump
 *
 * Rules enforced here:
 *  - UTC only, so no backup name depends on a server's timezone.
 *  - Names are strict patterns — anything that does not match is NOT one of
 *    ours and must never be selected for retention deletion.
 *  - A collision never overwrites: a second run in the same second gets an
 *    explicit `-2`, `-3` … suffix.
 */

export const BACKUP_PREFIX = 'backups/database/';
export const BACKUP_ID_PATTERN = /^educbt-\d{4}-\d{2}-\d{2}T\d{6}Z(?:-\d+)?$/;
export const BACKUP_KEY_PATTERN = /^backups\/database\/(\d{4})\/(\d{2})\/(\d{2})\/(educbt-\d{4}-\d{2}-\d{2}T\d{6}Z(?:-\d+)?)\.dump$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** `educbt-2026-09-03T220000Z` — seconds granularity, UTC. */
export function backupId(now: Date = new Date()): string {
  return (
    `educbt-${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  );
}

export function backupFilename(id: string): string {
  assertValidBackupId(id);
  return `${id}.dump`;
}

/** Storage key for a backup id, mirroring the UTC date of the id itself. */
export function backupKey(id: string): string {
  assertValidBackupId(id);
  const m = /^educbt-(\d{4})-(\d{2})-(\d{2})T/.exec(id);
  if (!m) throw new Error(`unparseable backup id: ${id}`);
  return `${BACKUP_PREFIX}${m[1]}/${m[2]}/${m[3]}/${id}.dump`;
}

export function assertValidBackupId(id: string): void {
  if (!BACKUP_ID_PATTERN.test(id)) {
    throw new Error(`invalid backup id: ${id}`);
  }
}

export interface ParsedBackupKey {
  key: string;
  id: string;
  /** The instant the backup was named for — the basis of age-based retention. */
  takenAt: Date;
}

/**
 * Strict parse of a storage key. Returns null for anything that is not one of
 * our backups — including objects inside our prefix with foreign names.
 * Retention only ever deletes keys that parse here.
 */
export function parseBackupKey(key: string): ParsedBackupKey | null {
  const m = BACKUP_KEY_PATTERN.exec(key);
  if (!m) return null;
  const id = m[4]!;
  // The id's own timestamp is authoritative; the -N collision suffix never
  // changes the instant it represents.
  const base = id.replace(/-\d+$/, '');
  const ts = /^educbt-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(base);
  if (!ts) return null;
  const takenAt = new Date(
    Date.UTC(+ts[1]!, +ts[2]! - 1, +ts[3]!, +ts[4]!, +ts[5]!, +ts[6]!),
  );
  if (Number.isNaN(takenAt.getTime())) return null;
  // The id's embedded date and the key's date folders must agree — a key
  // that lies about when its backup was taken must never drive retention.
  if (`${ts[1]}-${ts[2]}-${ts[3]}` !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  return { key, id, takenAt };
}

/**
 * Collision-safe id: if a backup with this id already exists (two jobs in the
 * same second), an explicit `-2`, `-3` … suffix is appended instead of any
 * overwrite. Never reuses an existing key.
 */
export async function nextAvailableId(
  baseId: string,
  exists: (id: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(baseId))) return baseId;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${baseId}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('could not allocate a collision-free backup id');
}
