/**
 * Pure unit test for the backup file format. No database.
 *   npx tsx src/lib/school-backup/format.test.ts
 */
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  buildDocument, encode, decode, canonicalJson, checksumOf, backupFileName, BackupFormatError, FORMAT_VERSION,
} from './format';

let count = 0;
const check = (name: string, fn: () => void) => { fn(); count++; console.log('PASS  ' + name); };
const rejects = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof BackupFormatError && pattern.test(e.message));

const sample = () => buildDocument({
  createdAt: '2026-11-17T10:00:00.000Z',
  credentials: 'none', app: { name: 'EduCBT', schemaTables: 48 },
  school: { name: 'Greenfield College', address: '1 Palm Road' },
  tables: {
    students: [{ id: 1, first_name: 'Ada', last_name: 'Bello' }, { id: 2, first_name: 'Chidi', last_name: 'Okoro' }],
    subjects: [{ id: 5, name: 'Mathematics' }],
  },
  uploads: { tok123: { mimeType: 'image/png', base64: 'AAAA' } },
});

check('a document survives encode then decode unchanged', () => {
  const doc = sample();
  const back = decode(encode(doc));
  assert.deepEqual(back, doc);
  assert.equal(back.counts.students, 2);
  assert.equal(back.version, FORMAT_VERSION);
});

check('the same data always gives the same checksum, whatever the key order', () => {
  const a = { x: 1, y: { b: 2, a: 1 } };
  const b = { y: { a: 1, b: 2 }, x: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
});

check('the checksum changes when any value changes', () => {
  const doc = sample(); const { checksum: _c, ...rest } = doc; void _c;
  const edited = { ...rest, tables: { ...rest.tables, students: [{ id: 1, first_name: 'Ada', last_name: 'CHANGED' }, rest.tables.students![1]!] } };
  assert.notEqual(checksumOf(edited as never), doc.checksum);
});

check('a file edited after it was made is rejected', () => {
  const doc = sample();
  doc.tables.students![0]!.last_name = 'Tampered'; // checksum no longer matches
  rejects(() => decode(encode(doc)), /integrity check/);
});

check('a file with rows removed is rejected (count mismatch)', () => {
  const doc = sample();
  doc.tables.students!.pop();
  rejects(() => decode(encode(doc)), /incomplete|says it has/);
});

check('a photo swapped after the backup was made is rejected', () => {
  const doc = sample();
  doc.uploads.tok123!.base64 = 'BBBB';
  rejects(() => decode(encode(doc)), /integrity check/);
});

check('a truncated file is rejected with a plain message', () => {
  const full = encode(sample());
  rejects(() => decode(full.subarray(0, Math.floor(full.length / 2))), /could not be unpacked|damaged|incomplete/);
});

check('random bytes are rejected', () => rejects(() => decode(Buffer.from('this is not a backup at all')), /not a valid EduCBT school backup/));
check('an empty file is rejected', () => rejects(() => decode(Buffer.alloc(0)), /empty/));

check('valid gzip of something that is not JSON is rejected', () => rejects(() => decode(gzipSync(Buffer.from('hello world'))), /not readable/));
check('valid JSON that is not a backup is rejected', () => rejects(() => decode(gzipSync(Buffer.from('{"hello":1}'))), /not an EduCBT school backup/));

check('a backup from a NEWER version is refused, not guessed at', () => {
  const doc = sample(); const { checksum: _c, ...rest } = doc; void _c;
  const future = { ...rest, version: FORMAT_VERSION + 1 };
  rejects(() => decode(gzipSync(Buffer.from(JSON.stringify({ ...future, checksum: checksumOf(future as never) })))), /newer version/);
});

check('a "zip bomb" that expands past the limit is refused', () => {
  const bomb = gzipSync(Buffer.alloc(650 * 1024 * 1024, 0x20));
  rejects(() => decode(bomb), /expands to more than/);
});

check('download names are safe and carry the date', () => {
  const n = backupFileName('St. Mary\'s / Girls "College" ../../etc', new Date('2026-11-17T10:00:00Z'));
  assert.match(n, /^[A-Za-z0-9-]+-backup-2026-11-17\.educbt-school\.gz$/);
  assert.ok(!n.includes('/') && !n.includes('..'));
  assert.match(backupFileName('???'), /^school-backup-/);
});

console.log('\n' + count + ' checks passed.');
