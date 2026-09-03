/**
 * Age-based retention selection.
 *
 * The rule is deliberately time-based, not count-based: everything our own
 * naming produced that is older than the retention window is selected for
 * deletion. Anything else — a newer backup, a foreign object that merely
 * sits inside our prefix, an object outside the prefix — is never selected.
 *
 * The caller is still expected to delete only through the same prefix-guarded
 * store API; this module never touches storage itself.
 */

import { parseBackupKey, BACKUP_PREFIX } from './naming';

export interface RetentionSelection {
  /** Keys safe to delete. Always our backups, always older than the window. */
  expired: string[];
  /** Our backups that stay. */
  retained: string[];
  /** Objects that are not ours — never candidates for deletion, reported so
   *  the operator notices unexpected content in the backup prefix. */
  foreign: string[];
}

export function selectRetention(
  keys: string[],
  retentionDays: number,
  now: Date = new Date(),
): RetentionSelection {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error('retention days must be an integer >= 1');
  }
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  const retained: string[] = [];
  const foreign: string[] = [];
  for (const key of keys) {
    // Keys outside the dedicated backup prefix are not our business at all —
    // not candidates, not reported, never touched. (The stores list with the
    // prefix anyway; this makes the safety property hold for any caller.)
    if (!key.startsWith(BACKUP_PREFIX)) continue;
    const parsed = parseBackupKey(key);
    if (!parsed) {
      foreign.push(key);
      continue;
    }
    // Strictly older than the full window. A backup taken exactly
    // `retentionDays` ago at this instant is retained.
    if (parsed.takenAt.getTime() < cutoff) expired.push(key);
    else retained.push(key);
  }
  // Deterministic order for stable logs and tests.
  expired.sort();
  retained.sort();
  foreign.sort();
  return { expired, retained, foreign };
}
