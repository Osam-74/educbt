/** Pure checks for the browser upload plan. npx tsx src/lib/school-backup/chunker.test.ts */
import assert from 'node:assert/strict';
import { PIECE_BYTES, planPieces, backoffMs, isRetryable, percent, formatBytes, MAX_ATTEMPTS } from './chunker';
import { MAX_CHUNK_BYTES, MAX_CHUNKS } from './upload';

let n = 0;
const check = (name: string, fn: () => void) => { fn(); n++; console.log('PASS  ' + name); };

check('a piece can never exceed what the server accepts, nor Vercel\'s 4.5 MB request limit', () => {
  assert.ok(PIECE_BYTES <= MAX_CHUNK_BYTES);
  assert.ok(PIECE_BYTES < 4.5 * 1024 * 1024);
});
check('pieces tile the file exactly: no gap, no overlap, nothing past the end', () => {
  for (const size of [1, 2, PIECE_BYTES - 1, PIECE_BYTES, PIECE_BYTES + 1, PIECE_BYTES * 3, PIECE_BYTES * 3 + 7, 50 * 1024 * 1024 + 13]) {
    const ps = planPieces(size);
    assert.equal(ps[0]!.start, 0); assert.equal(ps[ps.length - 1]!.end, size);
    for (let i = 0; i < ps.length; i++) {
      assert.equal(ps[i]!.position, i);
      assert.ok(ps[i]!.end > ps[i]!.start && ps[i]!.end - ps[i]!.start <= PIECE_BYTES);
      if (i) assert.equal(ps[i]!.start, ps[i - 1]!.end);
    }
    assert.equal(ps.reduce((t, p) => t + (p.end - p.start), 0), size);
  }
});
check('the number of pieces matches what the server will expect', () => {
  assert.equal(planPieces(PIECE_BYTES).length, 1);
  assert.equal(planPieces(PIECE_BYTES + 1).length, 2);
  assert.equal(planPieces(PIECE_BYTES * 4).length, 4);
});
check('a file at the supported maximum still fits the server\'s piece limit', () => {
  assert.ok(planPieces(150 * 1024 * 1024).length <= MAX_CHUNKS);
});
check('empty, negative, fractional and NaN sizes are refused', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => planPieces(bad as number));
  assert.throws(() => planPieces(10, 0));
});
check('retry waits grow, are capped, and stay within the jitter band', () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4].map((a) => backoffMs(a, mid)), [1000, 2000, 4000, 8000]);
  assert.equal(backoffMs(20, mid), 15000);
  for (let a = 1; a <= 8; a++) {
    const lo = backoffMs(a, () => 0), hi = backoffMs(a, () => 1);
    const base = Math.min(1000 * 2 ** (a - 1), 15000);
    assert.ok(lo >= base * 0.75 - 1 && hi <= base * 1.25 + 1);
  }
});
check('only transient failures are retried', () => {
  for (const s of [null, 408, 429, 500, 502, 503, 504]) assert.equal(isRetryable(s), true, String(s));
  for (const s of [400, 401, 403, 404, 413, 422]) assert.equal(isRetryable(s), false, String(s));
});
check('there is a hard cap on retries', () => assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10));
check('progress never claims 100% before the server confirms the finish', () => {
  assert.equal(percent(0, 10, false), 0); assert.equal(percent(5, 10, false), 50);
  assert.equal(percent(10, 10, false), 99); assert.equal(percent(10, 10, true), 100); assert.equal(percent(0, 0, false), 0);
});
check('sizes are shown in plain units', () => {
  assert.equal(formatBytes(512), '512 B'); assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB'); assert.equal(formatBytes(3 * 1024 ** 3), '3.00 GB');
});
console.log('\n' + n + ' checks passed.');
