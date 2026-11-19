/**
 * The plugin's backup file is the one input that crosses a trust boundary: it is uploaded by a person, made by another
 * system, and decides what lands in a school's database. Every way it can be wrong is a test here, built from a REAL
 * file the plugin's own exporter wrote (fixtures/plugin-real-export*.gz), never from hand-made JSON.
 *   npx tsx src/lib/school-backup/read-plugin-file.test.ts        (no database needed)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readPluginFile, looksLikePluginFile, PluginFileError } from './read-plugin-file';
import { prepareUploadedFile } from './prepare-upload';
import { translatePluginBackup } from './from-plugin';
import { decode } from './format';

const dir = new URL('./fixtures/', import.meta.url);
const real = readFileSync(new URL('plugin-real-export.gz', dir));
const realPw = readFileSync(new URL('plugin-real-export-with-passwords.gz', dir));
let pass = 0, fail = 0;
const check = (name: string, fn: () => void) => { try { fn(); pass++; console.log('PASS ', name); } catch (e) { fail++; console.log('FAIL ', name, '\n   ', (e as Error).message.split('\n')[0]); } };
const refused = (name: string, file: Buffer, needle: RegExp) => check(name, () => {
  assert.throws(() => readPluginFile(file), (e: unknown) => e instanceof PluginFileError && needle.test(e.message), `expected a refusal matching ${needle}`);
});

const lines = (f: Buffer) => gunzipSync(f).toString('utf8').slice(0, -1).split('\n');
const pack = (ls: string[]) => gzipSync(Buffer.from(ls.join('\n') + '\n'));
/** Re-seals a tampered file with a CORRECT checksum, so the refusal under test is the specific one and not just "checksum". */
function reseal(ls: string[]): string[] {
  const body = ls.slice(0, -1); const h = createHash('sha256');
  for (const l of body) h.update(l + '\n');
  const foot = JSON.parse(ls[ls.length - 1]!); delete foot.checksum;
  const footText = JSON.stringify(foot);
  h.update(footText + '\n');
  return [...body, JSON.stringify({ ...foot, checksum: h.digest('hex') })];
}

// ── a real file reads, and says what it holds
const p = readPluginFile(real);
check('a real file written by the plugin is accepted', () => { assert.equal(p.format, 'educbt-wp-school-backup'); assert.equal(p.credentials, 'none'); });
check('every row the footer promised is there, table by table', () => {
  const foot = JSON.parse(lines(real).at(-1)!); for (const [t, n] of Object.entries(foot.counts as Record<string, number>)) assert.equal(p.tables[t]?.length, n, t);
  assert.ok(Object.values(p.tables).reduce((a, r) => a + r.length, 0) > 700);
});
check('the router recognises a plugin file and leaves a SaaS file alone', () => {
  assert.equal(looksLikePluginFile(real), true);
  assert.equal(looksLikePluginFile(gzipSync(Buffer.from('{"format":"educbt-school-backup"}'))), false);
  assert.equal(looksLikePluginFile(Buffer.from('not gzip at all')), false);
  assert.equal(prepareUploadedFile(gzipSync(Buffer.from('{"x":1}'))).source, 'saas');
});
check('a file with no passwords holds no hash anywhere once read', () => {
  assert.equal(Object.values(p.wpUsers ?? {}).filter((u) => u.hash).length, 0);
  assert.equal(/\$wp\$|\$2y\$|\$P\$/.test(JSON.stringify(p)), false);
});
check('a file that declared passwords hands over each hash exactly as written', () => {
  const q = readPluginFile(realPw); assert.equal(q.credentials, 'password-hashes');
  const hashes = Object.values(q.wpUsers ?? {}).map((u) => u.hash); assert.equal(hashes.length >= 3, true); assert.ok(hashes.every((h) => !!h && /^(\$wp\$2y\$|\$2y\$|\$P\$)/.test(h!)));
});
check('the whole chain: real file -> read -> translate -> a valid SaaS backup', () => {
  const out = prepareUploadedFile(real); assert.equal(out.source, 'plugin'); const doc = decode(out.file);
  assert.equal(doc.school.name, 'Demo Secondary School'); assert.ok((doc.tables.students ?? []).length === 7); assert.ok(out.report!.translated.assessment_scores === 187);
});
check('translating the file read from disk gives the same result as the fixture used by the other suites', () => {
  const a = translatePluginBackup(p).report.translated; assert.equal(a.students, 7); assert.equal(a.bank_questions, 33); assert.equal(a.legacy_exam_attempts, 4);
});

// ── every way it can be wrong is refused, whole
refused('an empty file', Buffer.alloc(0), /empty/);
refused('plain text instead of a backup', Buffer.from('hello'), /not a school backup/);
refused('a gzip of something that is not a backup', gzipSync(Buffer.from('{"hello":1}\n')), /not readable|header|not a record/i);
refused('a file cut short (no footer)', pack(lines(real).slice(0, -1)), /no end|incomplete/i);
refused('a truncated download (gzip cut in half)', real.subarray(0, Math.floor(real.length / 2)), /could not be unpacked|damaged|incomplete/i);
refused('a changed value anywhere (checksum)', (() => { const l = lines(real); const i = l.findIndex((x) => x.includes('"table":"students"')); l[i] = l[i]!.replace(/"first_name":"[^"]*"/, '"first_name":"TAMPERED"'); return pack(l); })(), /integrity/i);
refused('a row deleted (counts no longer match)', (() => { const l = lines(real); const i = l.findIndex((x) => x.includes('"table":"students"')); l.splice(i, 1); return pack(l); })(), /integrity|rows|line total/i);
refused('a row added', (() => { const l = lines(real); const i = l.findIndex((x) => x.includes('"table":"students"')); l.splice(i, 0, l[i]!); return pack(l); })(), /integrity|rows|line total/i);
refused('content after the end', pack([...lines(real), '{"t":"row","table":"students","data":{"id":"99"}}']), /after its end/);
refused('a record of a kind it does not know', pack(reseal([lines(real)[0]!, '{"t":"script","data":{}}', ...lines(real).slice(1)])), /does not know|kind/);
refused('a line that is not JSON', pack(reseal([lines(real)[0]!, 'this is not json', ...lines(real).slice(1)])), /not readable/);
refused('a row with no table', pack(reseal([lines(real)[0]!, '{"t":"row","data":{"id":"1"}}', ...lines(real).slice(1)])), /incomplete row/);
refused('a file that does not start with its header', pack(reseal([lines(real)[1]!, lines(real)[0]!, ...lines(real).slice(2)])), /header/);
refused('a different product\'s file', pack(reseal([lines(real)[0]!.replace('educbt-wp-school-backup', 'some-other-product'), ...lines(real).slice(1)])), /not an EduCBT/);
refused('a file from a newer plugin than this platform knows', pack(reseal([lines(real)[0]!.replace('"version":1', '"version":99'), ...lines(real).slice(1)])), /newer version/);
refused('a header that does not say whether it carries passwords', pack(reseal([lines(real)[0]!.replace('"credentials":"none"', '"credentials":"maybe"'), ...lines(real).slice(1)])), /whether it carries passwords/);
refused('a PASSWORD HASH hidden in a file that says it holds none (checksum re-sealed to be valid)', pack(reseal((() => {
  const l = lines(real); const i = l.findIndex((x) => x.includes('"t":"wpuser"')); const rec = JSON.parse(l[i]!); rec.data.user_pass = '$P$Bsneaky'; l[i] = JSON.stringify(rec); return l;
})())), /password although it says it holds none/);
refused('the same account twice', pack(reseal((() => { const l = lines(real); const i = l.findIndex((x) => x.includes('"t":"wpuser"')); l.splice(i, 0, l[i]!); return l; })())), /twice|total/);
refused('an account with no id', pack(reseal((() => { const l = lines(real); const i = l.findIndex((x) => x.includes('"t":"wpuser"')); const r = JSON.parse(l[i]!); delete r.data.wp_user_id; l[i] = JSON.stringify(r); return l; })())), /incomplete account/);
refused('a photo record with no data', pack(reseal([lines(real)[0]!, '{"t":"file","name":"x.png"}', ...lines(real).slice(1)])), /incomplete file/);
refused('a zip bomb (tiny file that expands past the ceiling)', gzipSync(Buffer.alloc(700 * 1024 * 1024, 0x20)), /expands to more than/);

// ── each total is its own lock: re-seal a file whose rows and totals disagree, so ONLY that rule can refuse it
refused('a table that holds fewer rows than the footer says (re-sealed, line total also fixed up)', pack(reseal((() => {
  const l = lines(real); const i = l.findIndex((x) => x.includes('"table":"students"')); l.splice(i, 1);
  const f = JSON.parse(l.at(-1)!); f.lines -= 1; l[l.length - 1] = JSON.stringify(f); return l; })())), /says it has .* rows but holds/);
refused('a photo total that does not match (re-sealed)', pack(reseal((() => { const l = lines(real); const f = JSON.parse(l.at(-1)!); f.files = 3; l[l.length - 1] = JSON.stringify(f); return l; })())), /photo total/);
refused('an account total that does not match (re-sealed)', pack(reseal((() => { const l = lines(real); const f = JSON.parse(l.at(-1)!); f.wp_users = 9; l[l.length - 1] = JSON.stringify(f); return l; })())), /account total/);
refused('a line total that does not match (re-sealed)', pack(reseal((() => { const l = lines(real); const f = JSON.parse(l.at(-1)!); f.lines = 5; l[l.length - 1] = JSON.stringify(f); return l; })())), /line total/);

// ── the footer is authenticated too: a quietly changed total is caught even with every row intact
refused('a footer count changed (rows untouched)', (() => { const l = lines(real); const f = JSON.parse(l.at(-1)!); f.counts.students = 99; l[l.length - 1] = JSON.stringify(f); return pack(l); })(), /integrity|rows/);
check('a file with every record valid but sealed with the WRONG checksum is refused (not trusted on shape alone)', () => {
  const l = lines(real); const f = JSON.parse(l.at(-1)!); f.checksum = '0'.repeat(64); l[l.length - 1] = JSON.stringify(f);
  assert.throws(() => readPluginFile(pack(l)), (e: unknown) => e instanceof PluginFileError && /integrity/.test(e.message));
});

console.log(`\n${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
