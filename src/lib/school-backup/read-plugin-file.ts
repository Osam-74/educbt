/**
 * Reads the file the WordPress plugin writes and turns it into the object the translator expects.
 *
 * The plugin writes a gzip file of JSON lines: a header, one line per table row, one per person's WordPress
 * account, one per embedded photo, and a footer that carries the totals and a running SHA-256. Everything is
 * checked BEFORE a single row is trusted:
 *   - the gzip must unpack within a hard size ceiling (a small file that expands to gigabytes is refused),
 *   - every line must be one of the known record kinds and valid JSON,
 *   - the footer's checksum, per-table counts, file count and account count must all match what was read,
 *   - nothing may follow the footer,
 *   - a password hash in a file whose header says it holds none is refused, however the rest looks.
 * A file that fails any check is refused whole; nothing is half-read.
 */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { PluginBackup } from './from-plugin';

export const PLUGIN_FORMAT = 'educbt-wp-school-backup';
export const PLUGIN_FORMAT_VERSION = 1;
export const MAX_PLUGIN_COMPRESSED_BYTES = 150 * 1024 * 1024;
export const MAX_PLUGIN_UNCOMPRESSED_BYTES = 600 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export class PluginFileError extends Error {}

type Row = Record<string, unknown>;

/** True when the bytes are gzip and the first record is a plugin header. Never throws; used only to route a file. */
export function looksLikePluginFile(file: Buffer): boolean {
  if (file.length < 2 || file[0] !== 0x1f || file[1] !== 0x8b) return false;
  try {
    const head = gunzipSync(file, { maxOutputLength: 64 * 1024, finishFlush: 2 /* Z_SYNC_FLUSH: a partial read is fine */ }).toString('utf8');
    const first = head.split('\n', 1)[0] ?? '';
    return first.includes('"t":"header"') && first.includes(PLUGIN_FORMAT);
  } catch {
    // A file larger than the probe window throws on maxOutputLength; fall back to a bounded read of the start.
    try {
      const zlib = require('node:zlib') as typeof import('node:zlib');
      const part = zlib.gunzipSync(file.subarray(0, Math.min(file.length, 16 * 1024)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
      const first = part.split('\n', 1)[0] ?? '';
      return first.includes('"t":"header"') && first.includes(PLUGIN_FORMAT);
    } catch { return false; }
  }
}

export function readPluginFile(file: Buffer): PluginBackup {
  if (file.length === 0) throw new PluginFileError('The file is empty.');
  if (file.length > MAX_PLUGIN_COMPRESSED_BYTES) throw new PluginFileError('The file is larger than the supported maximum.');
  if (file[0] !== 0x1f || file[1] !== 0x8b) throw new PluginFileError('This is not a school backup file. Choose the .gz file downloaded from the plugin.');

  let raw: Buffer;
  try {
    raw = gunzipSync(file, { maxOutputLength: MAX_PLUGIN_UNCOMPRESSED_BYTES });
  } catch (e) {
    throw new PluginFileError(e instanceof Error && /Cannot create a Buffer larger|maxOutputLength/i.test(e.message)
      ? 'The file expands to more than the supported maximum.'
      : 'This backup could not be unpacked. The file may be damaged or incomplete.');
  }

  const text = raw.toString('utf8');
  if (!text.endsWith('\n')) throw new PluginFileError('The backup is incomplete: it does not end where it should.');
  const lines = text.slice(0, -1).split('\n');

  const hash = createHash('sha256');
  let header: Row | null = null;
  let footer: Row | null = null;
  const tables: Record<string, Row[]> = {};
  const uploads: Record<string, { mimeType: string; base64: string }> = {};
  const wpUsers: NonNullable<PluginBackup['wpUsers']> = {};
  let fileCount = 0, accountCount = 0, count = 0;
  const seenAccounts = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const n = i + 1;
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new PluginFileError(`The backup is damaged: line ${n} is far too long.`);
    if (footer) throw new PluginFileError('The backup is damaged: there is content after its end.');

    let rec: Row;
    try { rec = JSON.parse(line) as Row; } catch { throw new PluginFileError(`The backup is damaged: line ${n} is not readable.`); }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new PluginFileError(`The backup is damaged: line ${n} is not a record.`);

    if (rec.t === 'footer') {
      footer = rec;
      // The plugin hashes the footer too, minus its own checksum field. That field is always written LAST, so cutting
      // it off the original text gives exactly the bytes that were hashed, with no re-encoding to get subtly wrong.
      const cut = line.lastIndexOf(',"checksum":"');
      if (cut < 0 || !line.endsWith('"}')) throw new PluginFileError('The backup is damaged: its end record is not in the expected form.');
      hash.update(line.slice(0, cut) + '}\n');
      continue;
    }
    hash.update(line + '\n');
    count++;

    if (i === 0) {
      if (rec.t !== 'header') throw new PluginFileError('The backup is damaged: it does not start with its header.');
      if (rec.format !== PLUGIN_FORMAT) throw new PluginFileError('This file is not an EduCBT WordPress plugin school backup.');
      if (typeof rec.version !== 'number' || rec.version > PLUGIN_FORMAT_VERSION) {
        throw new PluginFileError(`This backup was made by a newer version of the plugin (format ${String(rec.version)}). Update the platform before importing it.`);
      }
      if (rec.credentials !== 'none' && rec.credentials !== 'password-hashes') throw new PluginFileError('The backup does not say whether it carries passwords.');
      if (!rec.school || typeof rec.school !== 'object') throw new PluginFileError('The backup is missing its school.');
      header = rec;
      continue;
    }
    if (!header) throw new PluginFileError('The backup is damaged: it does not start with its header.');

    if (rec.t === 'row') {
      if (typeof rec.table !== 'string' || !rec.data || typeof rec.data !== 'object' || Array.isArray(rec.data)) throw new PluginFileError(`The backup is damaged: line ${n} is an incomplete row.`);
      (tables[rec.table] ??= []).push(rec.data as Row);
    } else if (rec.t === 'wpuser') {
      const d = rec.data as Row | undefined;
      if (!d || typeof d !== 'object' || !Number.isInteger(d.wp_user_id)) throw new PluginFileError(`The backup is damaged: line ${n} is an incomplete account.`);
      const id = Number(d.wp_user_id);
      if (seenAccounts.has(id)) throw new PluginFileError(`The backup is damaged: account ${id} appears twice.`);
      seenAccounts.add(id);
      // The one mistake that must never pass: a password in a file that says it holds none.
      if (typeof d.user_pass === 'string' && d.user_pass !== '' && header.credentials !== 'password-hashes') {
        throw new PluginFileError('The backup holds a password although it says it holds none, so it was refused.');
      }
      wpUsers[String(id)] = { login: typeof d.user_login === 'string' ? d.user_login : null, email: typeof d.user_email === 'string' ? d.user_email : null,
        hash: typeof d.user_pass === 'string' && d.user_pass !== '' ? d.user_pass : null };
      accountCount++;
    } else if (rec.t === 'file') {
      if (typeof rec.name !== 'string' || typeof rec.base64 !== 'string' || typeof rec.mime !== 'string') throw new PluginFileError(`The backup is damaged: line ${n} is an incomplete file.`);
      uploads[rec.name] = { mimeType: rec.mime, base64: rec.base64 };
      fileCount++;
    } else {
      throw new PluginFileError(`The backup is damaged: line ${n} is of a kind this version does not know.`);
    }
  }

  if (!header) throw new PluginFileError('The backup is damaged: it has no header.');
  if (!footer) throw new PluginFileError('The backup is incomplete: it has no end. The download may have been cut short.');
  if (footer.checksum !== hash.digest('hex')) throw new PluginFileError('The backup failed its integrity check: it was changed or damaged after it was created. It will not be imported.');

  const counts = (footer.counts && typeof footer.counts === 'object' ? footer.counts : {}) as Record<string, number>;
  for (const t of new Set([...Object.keys(counts), ...Object.keys(tables)])) {
    if ((counts[t] ?? 0) !== (tables[t]?.length ?? 0)) throw new PluginFileError(`Table "${t}" says it has ${counts[t] ?? 0} rows but holds ${tables[t]?.length ?? 0}. The file is incomplete.`);
  }
  if (Number(footer.files ?? 0) !== fileCount) throw new PluginFileError('The backup is damaged: its photo total does not match its contents.');
  if (Number(footer.wp_users ?? 0) !== accountCount) throw new PluginFileError('The backup is damaged: its account total does not match its contents.');
  if (Number(footer.lines ?? -1) !== count + 1) throw new PluginFileError('The backup is damaged: its line total does not match its contents.');

  return {
    format: PLUGIN_FORMAT as 'educbt-wp-school-backup', version: Number(header.version), credentials: header.credentials as 'none' | 'password-hashes',
    school: header.school as Row, tables, ...(fileCount ? { uploads } : {}), ...(accountCount ? { wpUsers } : {}),
  };
}
