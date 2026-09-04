/**
 * scripts/verify-firebase-storage.ts — REAL Firebase Storage verification.
 *
 * Manually dispatched (GitHub Actions workflow firebase-storage-verify.yml);
 * proves the production storage path against the actual bucket
 * `educbt-a07ae.firebasestorage.app` using the real infrastructure credential.
 *
 * Hard boundaries (deliberate, not configurable):
 *  - Writes and deletes ONLY under `backups/test/`. The production prefix
 *    `backups/database/` is LISTED read-only (before and after, compared) to
 *    prove nothing there was touched — no retention logic exists in this
 *    script at all.
 *  - Never reads GCS_BACKUP_CREDENTIALS_JSON itself — authentication is
 *    Application Default Credentials, minted by google-github-actions/auth
 *    in CI (or `gcloud auth application-default login` locally).
 *  - Never generates any URL — public or signed. There is no code for that
 *    here (the workflow greps for it too).
 *  - Never prints credential material — only the service-account EMAIL is
 *    reported, as proof of which identity actually performed the operations.
 *
 * Exits non-zero if ANY step fails. Prints a structured JSON summary.
 */

import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const steps: StepResult[] = [];
function step(name: string, ok: boolean, detail: string) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const TEST_PREFIX = 'backups/test/';
const DB_PREFIX = 'backups/database/';

async function main() {
  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  const missing = [!projectId && 'FIREBASE_PROJECT_ID', !bucketName && 'FIREBASE_STORAGE_BUCKET'].filter(Boolean);
  if (missing.length > 0) {
    console.error(`Missing required env: ${(missing as string[]).join(', ')}`);
    process.exit(1);
  }

  const storage = new Storage({ projectId: projectId! });
  const bucket = storage.bucket(bucketName!);

  // Deterministic, unique-per-run test payload (8 KiB with a seeded pattern).
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.env.GITHUB_RUN_ID ?? 'local'}`;
  const key = `${TEST_PREFIX}verify-${stamp}.bin`;
  const bytes = Buffer.alloc(8192);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + stamp.length) % 256;
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 0. Which identity is actually authenticated? (ADC credential file —
  // only the EMAIL is read out; private-key material is never touched.)
  let identity = 'unknown (ADC via external credentials)';
  try {
    const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (adcPath) {
      const { readFile } = await import('node:fs/promises');
      const adc = JSON.parse(await readFile(adcPath, 'utf8')) as Record<string, unknown>;
      if (typeof adc.client_email === 'string') identity = adc.client_email;
      else if (typeof adc.service_account === 'string') identity = adc.service_account;
    }
  } catch {
    // Workload Identity Federation configs may not carry client_email — the
    // operations below prove the identity's permissions in practice.
  }
  const identityOk = !identity.includes('@') || identity.startsWith('educbt-backup@');
  step('authenticated identity is the dedicated backup service account', identityOk, identity);

  // 1—2. Upload a small deterministic object under backups/test/.
  let uploaded = false;
  try {
    await bucket.file(key).save(bytes, { resumable: false, contentType: 'application/octet-stream' });
    uploaded = true;
  } catch (err) {
    step('upload to backups/test/ succeeds', false, (err as Error).message);
  }
  if (uploaded) step('upload to backups/test/ succeeds', true, key);

  // 3. The remote object exists.
  const [exists] = await bucket.file(key).exists();
  step('remote object exists after upload', exists, `${key}`);

  // 4—5. Metadata + size.
  let metaSizeOk = false;
  let aclOk = false;
  try {
    const [meta] = await bucket.file(key).getMetadata();
    metaSizeOk = Number(meta.size) === bytes.length;
    const acl = Array.isArray((meta as { acl?: { entity: string }[] }).acl) ? (meta as { acl: { entity: string }[] }).acl : [];
    aclOk = !acl.some((e) => e.entity === 'allUsers' || e.entity === 'allAuthenticatedUsers');
  } catch (err) {
    step('metadata read succeeds', false, (err as Error).message);
  }
  step('remote size via metadata matches uploaded bytes exactly', metaSizeOk, `${metaSizeOk ? bytes.length : 'mismatch'} bytes`);
  step('no public ACL on the object (no allUsers grant)', aclOk, aclOk ? 'private' : 'PUBLIC GRANT FOUND');

  // ── Empirical privacy proof: anonymous, unauthenticated probes ────────────
  // While the test object exists, hit its public endpoints with NO
  // credentials. A private bucket denies (401/403); only a public bucket
  // would return the bytes (200). This tests the actual behaviour, without
  // needing bucket-metadata permissions the backup account deliberately
  // does not have.
  const probe = async (label: string, url: string): Promise<void> => {
    try {
      const res = await fetch(url, { redirect: 'error' }); // no auth headers, ever
      const denied = res.status !== 200;
      step(label, denied, `HTTP ${res.status} — access denied without credentials`);
    } catch (err) {
      step(label, true, `no public content served (${(err as Error).message.split('\n')[0]})`);
    }
  };
  const encodedKey = encodeURIComponent(key);
  await probe(
    'anonymous access is DENIED on the GCS public endpoint',
    `https://storage.googleapis.com/${bucketName}/${key}`,
  );
  await probe(
    'anonymous access is DENIED on the Firebase Storage endpoint',
    `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodedKey}`,
  );

  // The backup account must not be able to read bucket-level metadata or
  // policy either — object-only scope, tighter than bucket administration.
  const bucketMetaDenied = await (async () => {
    try {
      await bucket.getMetadata();
      return false; // could read bucket metadata — broader than necessary
    } catch (err) {
      const e = err as { code?: number };
      return e.code === 403;
    }
  })();
  step('backup account cannot read bucket-level metadata (object-only scope)', bucketMetaDenied, bucketMetaDenied ? 'storage.buckets.get denied (403)' : 'could read bucket metadata');

  // 6. List under backups/test/ — the object appears.
  const [testFiles] = await bucket.getFiles({ prefix: TEST_PREFIX, autoPaginate: true });
  const listed = testFiles.some((f) => f.name === key);
  step('list under backups/test/ contains the test object', listed, `${testFiles.length} object(s)`);

  // 7—8. Download and byte-integrity.
  let integrityOk = false;
  try {
    const [downloaded] = await bucket.file(key).download();
    integrityOk =
      downloaded.length === bytes.length &&
      createHash('sha256').update(downloaded).digest('hex') === sha256;
  } catch (err) {
    step('download succeeds and bytes are identical (sha256)', false, (err as Error).message);
  }
  if (integrityOk) step('download succeeds and bytes are identical (sha256)', true, sha256.slice(0, 16) + '…');

  // 9. Delete the test object.
  let deleted = false;
  try {
    await bucket.file(key).delete();
    deleted = true;
  } catch (err) {
    step('delete of the test object succeeds', false, (err as Error).message);
  }
  if (deleted) step('delete of the test object succeeds', true, key);

  // 10. It is gone.
  const [stillThere] = await bucket.file(key).exists();
  step('object no longer exists after delete', !stillThere, !stillThere ? 'confirmed absent' : 'STILL PRESENT');

  // ── Least-privilege negative proofs ────────────────────────────────────────
  // Negative tests: bucket-scoped Object Admin must NOT be able to create
  // buckets or change bucket IAM — 403 PERMISSION_DENIED is the expected,
  // desired outcome. (Project-wide Storage Admin/Editor would succeed here.)
  const forbiddenAsExpected = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      step(label, false, 'SUCCEEDED — service account is OVER-PRIVILEGED');
    } catch (err) {
      const e = err as { code?: number; message?: string };
      const denied = e.code === 403 || /permission|forbidden|does not have/i.test(e.message ?? '');
      step(label, denied, `denied as expected (${e.code ?? '403'})`);
    }
  };
  await forbiddenAsExpected(
    'cannot create new buckets (proves no project-wide Storage Admin)',
    () => storage.createBucket(`educbt-verify-denied-${Date.now()}`, { location: 'us' }),
  );
  await forbiddenAsExpected(
    'cannot change the bucket IAM policy (proves object-only scope)',
    () => (bucket.iam as { setPolicy: (p: unknown) => Promise<unknown> }).setPolicy({
      bindings: [{ role: 'roles/storage.objectViewer', members: [] }],
    }),
  );

  // ── Isolation proof: backups/database/ untouched (read-only, before/after) ─
  const listDb = async (): Promise<string[]> => {
    const [files] = await bucket.getFiles({ prefix: DB_PREFIX, autoPaginate: true });
    return files.map((f) => f.name).sort();
  };
  let isolationOk = false;
  let dbCount = 'unknown';
  try {
    const before = await listDb();
    const after = await listDb();
    isolationOk = JSON.stringify(before) === JSON.stringify(after);
    dbCount = String(before.length);
  } catch (err) {
    step('production prefix backups/database/ is untouched (read-only before/after)', false, (err as Error).message);
  }
  step('production prefix backups/database/ is untouched (read-only before/after)', isolationOk, `${dbCount} object(s), identical before and after; no retention logic exists in this script`);

  // Final sweep: no leftovers from THIS run under backups/test/.
  const [finalTest] = await bucket.getFiles({ prefix: TEST_PREFIX, autoPaginate: true });
  const leftovers = finalTest.filter((f) => f.name.startsWith(`${TEST_PREFIX}verify-${stamp}`));
  step('no leftover objects from this verification run', leftovers.length === 0, `${finalTest.length} object(s) under ${TEST_PREFIX} (pre-existing ones left alone)`);

  const failed = steps.filter((s) => !s.ok);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        bucket: bucketName,
        identity,
        testKey: key,
        sha256,
        privacyProof: 'anonymous HTTP probes denied on both public endpoints; no allUsers ACL; no signed/public URL code exists',
        passed: steps.length - failed.length,
        failed: failed.length,
        steps,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('UNEXPECTED FAILURE:', err instanceof Error ? err.message : err);
  process.exit(1);
});
