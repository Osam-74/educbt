/**
 * The backup file format. Pure functions: no database, no network, so they are unit-testable.
 *
 * A backup is ONE gzip-compressed JSON document:
 *
 *   {
 *     format: 'educbt-school-backup', version: 1,
 *     createdAt, app: { ... },
 *     school:  { ...the school row, minus its identity... },
 *     tables:  { academic_sessions: [ {...}, ... ], terms: [...], ... },
 *     uploads: { <old token>: { mimeType, base64 } },        // the photos
 *     counts:  { academic_sessions: 3, ... },
 *     checksum: '<sha256 of everything above, canonicalised>'
 *   }
 *
 * The checksum is computed over the document WITHOUT the checksum field, so a file that was
 * truncated, edited or corrupted in transit is rejected before a single row is written.
 */
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const FORMAT = 'educbt-school-backup';
export const FORMAT_VERSION = 1;

/** Refuse absurd inputs before they can exhaust memory. A real school is far below both. */
export const MAX_COMPRESSED_BYTES = 150 * 1024 * 1024;
export const MAX_UNCOMPRESSED_BYTES = 600 * 1024 * 1024;

export type BackupDocument = {
  format: typeof FORMAT;
  version: number;
  createdAt: string;
  app: { name: 'EduCBT'; schemaTables: number };
  /**
   * What sign-in material the file carries.
   *   'none'            no credentials: every login must be issued a password after a restore (default)
   *   'password-hashes' each user's Argon2id password hash, so people keep their current passwords.
   *                     The file is then a SENSITIVE credential store and must be kept as one.
   * Two-factor secrets, recovery codes, sessions and invite links are never carried in either mode.
   */
  credentials: 'none' | 'password-hashes';
  school: Record<string, unknown>;
  tables: Record<string, Array<Record<string, unknown>>>;
  uploads: Record<string, { mimeType: string; base64: string }>;
  counts: Record<string, number>;
  checksum: string;
};

export class BackupFormatError extends Error {}

/** JSON with sorted keys, so the same data always produces the same bytes (and the same checksum). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    return v;
  });
}

export function checksumOf(doc: Omit<BackupDocument, 'checksum'>): string {
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}

export function buildDocument(parts: Omit<BackupDocument, 'format' | 'version' | 'checksum' | 'counts'>): BackupDocument {
  const counts: Record<string, number> = {};
  for (const [t, rows] of Object.entries(parts.tables)) counts[t] = rows.length;
  const body = { format: FORMAT, version: FORMAT_VERSION, ...parts, counts } as Omit<BackupDocument, 'checksum'>;
  return { ...body, checksum: checksumOf(body) };
}

export function encode(doc: BackupDocument): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 6 });
}

/**
 * Open and VERIFY a backup file. Throws BackupFormatError with a plain-English reason on any
 * problem: not gzip, too large, not JSON, wrong format, a newer version than this app
 * understands, a count that does not match its rows, or a checksum mismatch.
 */
export function decode(file: Buffer): BackupDocument {
  if (file.length === 0) throw new BackupFormatError('The file is empty.');
  if (file.length > MAX_COMPRESSED_BYTES) throw new BackupFormatError('The file is larger than the supported maximum.');

  let raw: Buffer;
  try {
    // maxOutputLength stops a tiny file that expands to gigabytes (a "zip bomb").
    raw = gunzipSync(file, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch (e) {
    const msg = e instanceof Error && /Cannot create a Buffer larger|maxOutputLength/i.test(e.message)
      ? 'The file expands to more than the supported maximum.'
      : 'This is not a valid EduCBT school backup (it could not be unpacked). The file may be damaged or incomplete.';
    throw new BackupFormatError(msg);
  }

  let doc: BackupDocument;
  try { doc = JSON.parse(raw.toString('utf8')) as BackupDocument; }
  catch { throw new BackupFormatError('This is not a valid EduCBT school backup (its contents are not readable).'); }

  if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) throw new BackupFormatError('This file is not an EduCBT school backup.');
  if (typeof doc.version !== 'number' || doc.version > FORMAT_VERSION) {
    throw new BackupFormatError(`This backup was made by a newer version of EduCBT (format ${doc.version}). Update the platform before restoring it.`);
  }
  if (!doc.tables || typeof doc.tables !== 'object' || !doc.school || typeof doc.school !== 'object') {
    throw new BackupFormatError('The backup is missing its school or its tables.');
  }
  for (const [t, rows] of Object.entries(doc.tables)) {
    if (!Array.isArray(rows)) throw new BackupFormatError(`Table "${t}" in the backup is malformed.`);
    if (doc.counts?.[t] !== rows.length) throw new BackupFormatError(`Table "${t}" says it has ${doc.counts?.[t]} rows but contains ${rows.length}. The file is incomplete.`);
  }

  // Verify the document EXACTLY as it was written, before any normalising: the checksum covers the
  // bytes the exporter produced, including a file from before the `credentials` field existed.
  const { checksum, ...rest } = doc;
  if (checksumOf(rest as Omit<BackupDocument, 'checksum'>) !== checksum) {
    throw new BackupFormatError('The backup failed its integrity check: it was changed or damaged after it was created. It will not be restored.');
  }
  // Only now: a file made before the field existed carried no credentials, and anything unrecognised
  // is treated the same way. Only the exact value 'password-hashes' ever turns hashes on.
  if (doc.credentials !== 'password-hashes') (doc as { credentials: string }).credentials = 'none';
  return doc;
}

/** A safe download name: no path characters, includes the date. */
export function backupFileName(schoolName: string, when: Date = new Date(), withPasswords = false): string {
  const slug = schoolName.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'school';
  // A file that carries password hashes says so in its name, so it is not mistaken for a safe one.
  return `${slug}-backup-${when.toISOString().slice(0, 10)}${withPasswords ? '-WITH-PASSWORDS' : ''}.educbt-school.gz`;
}
