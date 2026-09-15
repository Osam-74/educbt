/**
 * TOTP two-factor regression suite.
 *
 * Proven against the REAL educbt_app role (RLS on):
 *
 *   1. The RFC 6238 engine: the RFC's own SHA-1 test vectors, code format
 *      validation, one step of drift tolerance, and constant rejection of
 *      malformed codes/secrets.
 *   2. Enrollment lifecycle: start stores a DISABLED secret that changes
 *      nothing about sign-in; confirm requires a code the authenticator
 *      actually generated; disable requires a valid current code; a tenantless
 *      session cannot touch another school's account (read fails closed
 *      before any write is attempted).
 *   3. The sign-in gate: an enabled account refuses password-only sign-in,
 *      a wrong code burns the same lockout budget as a wrong password, and a
 *      correct code signs in with the counters reset.
 *
 * Fixture standard: a dedicated private school, deleted-then-recreated, no
 * production constraints weakened. Owner connection for the fixture and the
 * live-row assertions; application-role modules under test connect via
 * DATABASE_URL_APP.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import { authenticateCredentials, verifySecondFactor } from '@/lib/auth/credentials';
import { remainingRecoveryCodes } from '@/lib/auth/recovery-codes';
import { hashPassword } from '@/lib/auth/password';
import { verifyTotp, currentTotpCode, generateTotpSecret } from '@/lib/auth/totp';
import {
  TotpError,
  confirmTotpEnrollment,
  disableTotp,
  pendingEnrollment,
  startTotpEnrollment,
  totpStatus,
} from '@/lib/auth/totp-account';

const schema = { ...core, ...people };
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

const SCHOOL_CODE = 'TOTP-FIXTURE';
const PASSWORD = 'Fixt-Totp!23';

/** Expect a TotpError with a fragment of its message. */
async function rejectsTotp(name: string, fragment: string, fn: () => Promise<unknown>) {
  let caught = '';
  try {
    await fn();
  } catch (e) {
    caught = e instanceof TotpError ? e.message : `WRONG-ERROR-TYPE:${(e as Error).message}`;
  }
  check(name, caught.includes(fragment), caught);
}

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) throw new Error('DATABASE_URL_UNPOOLED required.');
  const owner = postgres(ownerUrl, { max: 1 });
  const odb = drizzle(owner, { schema });

  try {
    // ── Fixture: a dedicated private school (rerun-safe) ─────────────────────
    await odb.delete(core.schools).where(eq(core.schools.code, SCHOOL_CODE));

    const [school] = await odb
      .insert(core.schools)
      .values({
        name: 'TOTP Fixture School', code: SCHOOL_CODE,
        subdomain: 'totpfixture', status: 'active',
      } as never)
      .returning();
    const schoolId = Number(school!.id);

    const hash = await hashPassword(PASSWORD);
    const [principal] = await odb
      .insert(people.users)
      .values({
        schoolId, role: 'principal', loginId: 'TOTP-PRIN', passwordHash: hash,
        status: 'active', mustChangePassword: false,
      } as never)
      .returning();
    const principalId = Number(principal!.id);
    await odb
      .insert(people.staff)
      .values({
        schoolId, userId: principalId, staffNumber: 'TOTP-STF-1',
        firstName: 'Totp', lastName: 'Fixture', role: 'principal', status: 'active',
      } as never);
    const session = { id: principalId, schoolId };

    // ── 1. The RFC 6238 engine ──────────────────────────────────────────────
    // The RFC's SHA-1 test vectors (Appendix B), 6-digit truncation: base32
    // of "12345678901234567890". The RFC prints 8 digits — 94287082, 07081804,
    // 14050471, 89005924, 69279037, 65353130 — and a 6-digit authenticator
    // shows the same value modulo 10^6.
    const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const vectors: Array<[string, number, string]> = [
      ['287082', 59, 'T=59s'],
      ['081804', 1111111109, 'T=1111111109s'],
      ['050471', 1111111111, 'T=1111111111s'],
      ['005924', 1234567890, 'T=1234567890s'],
      ['279037', 2000000000, 'T=2000000000s'],
      ['353130', 20000000000, 'T=20000000000s'],
    ];
    for (const [code, seconds, label] of vectors) {
      check(`RFC 6238 vector ${label}`, verifyTotp(RFC_SECRET, code, new Date(seconds * 1000)));
    }

    check('a wrong code is rejected', !verifyTotp(RFC_SECRET, '000000', new Date(59 * 1000)));
    check('a malformed code is rejected', !verifyTotp(RFC_SECRET, '75522', new Date(59 * 1000)));
    check('a malformed secret is rejected', !verifyTotp('not!base32!', '755224', new Date(59 * 1000)));
    check('an empty code is rejected', !verifyTotp(RFC_SECRET, '', new Date(59 * 1000)));

    // Drift tolerance: the code from the previous step still verifies, the
    // one from two steps back does not.
    const t = 1_000_000_000_000;
    const driftSecret = generateTotpSecret();
    const prev = currentTotpCode(driftSecret, new Date(t - 30_000));
    const far = currentTotpCode(driftSecret, new Date(t - 90_000));
    check('previous step accepted (±30s clock drift)', verifyTotp(driftSecret, prev, new Date(t)));
    check('two steps back rejected', !verifyTotp(driftSecret, far, new Date(t)));
    check('currentTotpCode verifies against its own instant',
      verifyTotp(driftSecret, currentTotpCode(driftSecret, new Date(t)), new Date(t)));
    check('generated secrets are 32-char base32 (160 bits)',
      /^[A-Z2-7]{32}$/.test(driftSecret));

    // ── 2. Enrollment lifecycle ──────────────────────────────────────────────
    const before = await totpStatus(session);
    check('two-factor starts off', before.enabled === false);

    const started = await startTotpEnrollment(session);
    check('start returns a secret and a provisioning uri',
      /^[A-Z2-7]{32}$/.test(started.secret) && started.uri.startsWith('otpauth://totp/'));
    check('the uri carries the secret for authenticator apps',
      started.uri.includes(`secret=${started.secret}`));

    const midStatus = await totpStatus(session);
    check('an unconfirmed secret leaves two-factor off', midStatus.enabled === false);

    const pending = await pendingEnrollment(session);
    check('the pending secret is readable for the enrollment screen',
      pending?.secret === started.secret);

    // While unconfirmed, sign-in is unchanged — password only.
    const mid = await authenticateCredentials({
      loginId: 'TOTP-PRIN', password: PASSWORD, schoolId,
    });
    check('unconfirmed secret does not gate sign-in', mid.user.id === principalId);

    await rejectsTotp('confirm rejects a wrong code', 'not recognised',
      () => confirmTotpEnrollment(session, '000000'));
    check('a wrong confirm leaves two-factor off',
      (await totpStatus(session)).enabled === false);

    const { recoveryCodes } = await confirmTotpEnrollment(session, currentTotpCode(started.secret));
    check('a correct confirm turns two-factor on',
      (await totpStatus(session)).enabled === true);
    check('confirm issues 8 one-time recovery codes',
      recoveryCodes.length === 8 && recoveryCodes.every((c) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(c)),
      JSON.stringify(recoveryCodes.slice(0, 1)));
    check('no pending enrollment remains once enabled',
      (await pendingEnrollment(session)) === null);

    await rejectsTotp('start refuses an already-enabled account', 'already on',
      () => startTotpEnrollment(session));

    // A wrong-tenant session must fail closed BEFORE any write: the read is
    // tenant-scoped, so the account simply does not exist to it.
    await rejectsTotp('another tenant cannot touch this account', 'not found',
      () => startTotpEnrollment({ id: principalId, schoolId: schoolId + 999_999 }));

    // ── 3. The staged sign-in gate ───────────────────────────────────────────
    // Stage 1: password only. The account has two-factor on, so NO session
    // yet — just the instruction to go to /sign-in/two-step.
    const staged = await authenticateCredentials({
      loginId: 'TOTP-PRIN', password: PASSWORD, schoolId,
    });
    check('stage 1 passes and asks for the second factor',
      staged.secondFactorRequired === true && staged.user.id === principalId);

    const [noBurn] = await odb
      .select({ attempts: people.users.failedAttempts })
      .from(people.users).where(eq(people.users.id, principalId)).limit(1);
    check('stage 1 does not reset or burn the lockout budget', noBurn!.attempts === 0);

    const stage2 = { userId: principalId, schoolId, loginId: 'TOTP-PRIN' };

    let wrongCode = '';
    try {
      await verifySecondFactor(stage2, '000000');
    } catch (e) {
      wrongCode = (e as Error).message;
    }
    check('a wrong code is refused at stage 2', wrongCode.includes('not recognised'), wrongCode);

    const [afterWrong] = await odb
      .select({ attempts: people.users.failedAttempts })
      .from(people.users).where(eq(people.users.id, principalId)).limit(1);
    check('a wrong code burns the same budget as a wrong password', afterWrong!.attempts === 1);

    const signedIn = await verifySecondFactor(stage2, currentTotpCode(started.secret));
    check('a correct code completes the staged sign-in',
      signedIn.user.id === principalId && signedIn.recoveryCodeUsed === false);

    const [afterOk] = await odb
      .select({ attempts: people.users.failedAttempts })
      .from(people.users).where(eq(people.users.id, principalId)).limit(1);
    check('success resets the counters', afterOk!.attempts === 0);

    // A code from the previous step signs in too (drift tolerance at the gate).
    const drifted = await verifySecondFactor(
      stage2, currentTotpCode(started.secret, new Date(Date.now() - 30_000)));
    check('a previous-step code signs in (clock drift)', drifted.user.id === principalId);

    // ── 3b. Recovery codes ─────────────────────────────────────────────────
    check('eight recovery codes remain', (await remainingRecoveryCodes(session)) === 8);

    let wrongRecovery = '';
    try {
      await verifySecondFactor(stage2, 'ZZZZZ-ZZZZZ');
    } catch (e) {
      wrongRecovery = (e as Error).message;
    }
    check('a wrong recovery code is refused like a wrong code',
      wrongRecovery.includes('not recognised'), wrongRecovery);

    const usedRecovery = await verifySecondFactor(stage2, recoveryCodes[0]!);
    check('a recovery code completes the staged sign-in',
      usedRecovery.recoveryCodeUsed === true && usedRecovery.user.id === principalId);
    check('a recovery code forces a password change', usedRecovery.user.mustChangePassword === true);
    check('the code is spent', (await remainingRecoveryCodes(session)) === 7);

    let replayed = '';
    try {
      await verifySecondFactor(stage2, recoveryCodes[0]!);
    } catch (e) {
      replayed = (e as Error).message;
    }
    check('a used recovery code cannot be replayed',
      replayed.includes('not recognised') || replayed.includes('locked'), replayed);

    // ── 4. Disable ───────────────────────────────────────────────────────────
    await rejectsTotp('disable rejects a wrong code', 'not recognised',
      () => disableTotp(session, '000000'));
    check('a failed disable leaves two-factor on',
      (await totpStatus(session)).enabled === true);

    await disableTotp(session, currentTotpCode(started.secret));
    check('a correct code turns two-factor off',
      (await totpStatus(session)).enabled === false);

    const [cleared] = await odb
      .select({ secret: people.users.totpSecret })
      .from(people.users).where(eq(people.users.id, principalId)).limit(1);
    check('the secret is cleared on disable', cleared!.secret === null);

    check('disabling two-factor clears the recovery codes',
      (await remainingRecoveryCodes(session)) === 0);

    const afterDisable = await authenticateCredentials({
      loginId: 'TOTP-PRIN', password: PASSWORD, schoolId,
    });
    check('password-only sign-in works again',
      afterDisable.user.id === principalId && afterDisable.secondFactorRequired === false);

    await rejectsTotp('disable on an account without two-factor fails cleanly',
      'not on', () => disableTotp(session, '000000'));

    console.log(failures === 0 ? `\nTOTP OK: all checks passed.` : `\nTOTP FAILURES: ${failures}`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
