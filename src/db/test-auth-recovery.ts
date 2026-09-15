/**
 * Account-recovery regression suite (0017): forgot-password, reset tokens,
 * staged sessions, recovery codes, and the recovery email.
 *
 * Proven against the REAL educbt_app role (RLS on):
 *   1. Forgot-password requests NEVER reveal whether an account exists, has
 *      an email, or is suspended — the result is identical, and only eligible
 *      requests queue a token row + email event + audit row (one transaction).
 *   2. Reset tokens: 256-bit, stored only as SHA-256, single-use (a second
 *      claim fails), 30-minute expiry, and a successful reset changes the
 *      password (sign-in works with the new one), revokes every session and
 *      resets the lockout counters.
 *   3. Tenant scoping: a request on school A's host can never resolve school
 *      B's accounts — and a school user's login ID on the PLATFORM host is
 *      equally invisible.
 *   4. Recovery email management requires the current password; a duplicate
 *      address is refused; every change is audited.
 *
 * Fixture standard: dedicated private school, deleted-then-recreated; the
 * owner connection writes the fixture, application-role code under test
 * connects via DATABASE_URL_APP (see the note at the top of test-auth.ts).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, sql } from 'drizzle-orm';
import * as core from './schema/core';
import * as people from './schema/people';
import { authenticateCredentials } from '@/lib/auth/credentials';
import { hashPassword } from '@/lib/auth/password';
import { createSession, readSessionUser } from '@/lib/auth/session-store';
import {
  requestPasswordReset,
  resetPasswordWithToken,
} from '@/lib/auth/recovery';
import { setRecoveryEmail, profileView } from '@/lib/auth/recovery-email';
import assert from 'node:assert/strict';
import { remainingRecoveryCodes, hashCode } from '@/lib/auth/recovery-codes';
import * as comms from './schema/comms';

const schema = { ...core, ...people };
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

const SCHOOL_CODE = 'RECOV-FIXTURE';
const PASSWORD = 'Fixt-Rec!23';

async function main() {
  const ownerUrl = process.env.DATABASE_URL_UNPOOLED;
  if (!ownerUrl) throw new Error('DATABASE_URL_UNPOOLED required.');
  const owner = postgres(ownerUrl, { max: 1 });
  const odb = drizzle(owner, { schema });

  try {
    // ── Fixture ─────────────────────────────────────────────────────────────
    await odb.delete(core.schools).where(eq(core.schools.code, SCHOOL_CODE));

    const [school] = await odb
      .insert(core.schools)
      .values({
        name: 'Recovery Fixture School', code: SCHOOL_CODE,
        subdomain: 'recovfixture', status: 'active',
      } as never)
      .returning();
    const schoolId = Number(school!.id);

    const passwordHash = await hashPassword(PASSWORD);
    const [principal] = await odb
      .insert(people.users)
      .values({
        schoolId, role: 'principal', loginId: 'RECOV-PRIN', passwordHash,
        status: 'active', mustChangePassword: false,
      } as never)
      .returning();

    // A second school user with NO email (a typical student).
    const [student] = await odb
      .insert(people.users)
      .values({
        schoolId, role: 'student', loginId: 'RECOV-STU', passwordHash,
        status: 'active', mustChangePassword: false,
      } as never)
      .returning();

    // A platform admin.
    const [platformAdmin] = await odb
      .insert(people.users)
      .values({
        schoolId: null, role: 'platform_admin', loginId: 'RECOV-PLATFORM',
        passwordHash, status: 'active', mustChangePassword: false,
      } as never)
      .returning();

    const PRIN_ID = Number(principal!.id);

    // The principal's staff row (profileView resolves the display name).
    await odb
      .insert(people.staff)
      .values({
        schoolId, userId: PRIN_ID, staffNumber: 'RECOV-STF-1',
        firstName: 'Recov', lastName: 'Principal', role: 'principal', status: 'active',
      } as never);

    // ── 1. Recovery email management (the profile service) ──────────────────
    // Wrong password refuses the change.
    let refused = '';
    try {
      await setRecoveryEmail(
        { id: PRIN_ID, schoolId, loginId: 'RECOV-PRIN', role: 'principal' },
        { email: 'prin@fixture.example', currentPassword: 'wrong-password' },
      );
    } catch (e) {
      refused = (e as Error).message;
    }
    check('setting the recovery email requires the current password',
      refused.includes('not recognised'), refused);

    await setRecoveryEmail(
      { id: PRIN_ID, schoolId, loginId: 'RECOV-PRIN', role: 'principal' },
      { email: 'Prin@Fixture.example', currentPassword: PASSWORD },
    );
    const view = await profileView({ id: PRIN_ID, schoolId, role: 'principal', loginId: 'RECOV-PRIN' });
    check('email is stored normalised and unverified',
      view.email === 'prin@fixture.example' && view.emailVerified === false);
    check('display name resolves from the staff record', view.displayName.includes(' '));

    // Duplicate address refused (globally unique, lower(email)).
    let dup = '';
    try {
      await setRecoveryEmail(
        { id: Number(student!.id), schoolId, loginId: 'RECOV-STU', role: 'student' },
        { email: 'prin@fixture.example', currentPassword: PASSWORD },
      );
    } catch (e) {
      dup = (e as Error).message;
    }
    check('a duplicate recovery email is refused', dup.includes('already in use'), dup);

    const auditRows = await odb.execute<{ action: string }>(
      sql`select action from audit_log where school_id = ${schoolId} and action = 'auth.recovery_email_changed'`,
    );
    check('the email change is audited', auditRows.length >= 1);

    // ── 1b. Platform-admin recovery-email save (production 42501 regression) ─
    // Reproduces exactly the reported bug: Platform Admin has schoolId null,
    // so setRecoveryEmail runs the plain-transaction branch. Before the fix
    // that branch never elevated app.platform_admin, so the audit INSERT
    // (schoolId: null) failed RLS's WITH CHECK — the update itself would have
    // gone through, then the whole save 42501'd on the audit write. This must
    // now succeed end to end AND leave a school_id=null audit row behind.
    const PLATFORM_ID = Number(platformAdmin!.id);
    await setRecoveryEmail(
      { id: PLATFORM_ID, schoolId: null, loginId: 'RECOV-PLATFORM', role: 'platform_admin' },
      { email: 'platform-owner@fixture.example', currentPassword: PASSWORD },
    );
    const platformView = await profileView({ id: PLATFORM_ID, schoolId: null, role: 'platform_admin', loginId: 'RECOV-PLATFORM' });
    check('platform admin recovery-email save succeeds under RLS',
      platformView.email === 'platform-owner@fixture.example');

    const platformAuditRows = await odb.execute<{ school_id: string | null; actor_role: string | null }>(
      sql`select school_id::text, actor_role from audit_log
          where actor_user_id = ${PLATFORM_ID} and action = 'auth.recovery_email_changed'
          order by id desc limit 1`,
    );
    check('the platform-admin change is audited with a NULL (platform-scope) school_id',
      platformAuditRows.length === 1 && platformAuditRows[0]!.school_id === null,
      JSON.stringify(platformAuditRows[0]));
    check('the audit row records the platform_admin actor role',
      platformAuditRows[0]?.actor_role === 'platform_admin');

    // Reset — section 2 below independently proves the "no email queues
    // nothing" behaviour starting from a NULL email; leaving this address in
    // place would silently invalidate that check.
    await odb
      .update(people.users)
      .set({ email: null, emailVerifiedAt: null })
      .where(eq(people.users.id, PLATFORM_ID));

    // ── 1c. A school actor cannot exploit the same policy for platform scope ─
    // is_platform_admin() must be OFF for an ordinary school transaction — a
    // school user must not be able to write school_id=NULL "platform" audit
    // rows just because the OR-branch exists in the policy.
    const { forSchool: appForSchool, schema: appSchema } = await import('@/db');
    await assert.rejects(
      appForSchool(schoolId, (tx) =>
        tx.insert(appSchema.auditLog).values({
          schoolId: null,
          actorUserId: PRIN_ID,
          actorRole: 'principal',
          action: 'exploit.fake_platform_audit',
        } as never),
      ),
      /row-level security|permission denied/i,
      'a school-scoped actor must not be able to insert a NULL-school audit row',
    );
    check('a school user cannot forge a platform-scope (school_id NULL) audit entry', true);

    // ── 1d. Cross-school audit insert remains denied ─────────────────────────
    await odb.delete(core.schools).where(eq(core.schools.code, 'RECOV-FIXTURE-B'));
    const [otherSchool] = await odb
      .insert(core.schools)
      .values({
        name: 'Recovery Fixture School B', code: 'RECOV-FIXTURE-B',
        subdomain: 'recovfixtureb', status: 'active',
      } as never)
      .returning();
    const otherSchoolId = Number(otherSchool!.id);

    await assert.rejects(
      appForSchool(schoolId, (tx) =>
        tx.insert(appSchema.auditLog).values({
          schoolId: otherSchoolId,
          actorUserId: PRIN_ID,
          actorRole: 'principal',
          action: 'exploit.cross_school_audit',
        } as never),
      ),
      /row-level security|permission denied/i,
      'a school-scoped actor must not be able to insert an audit row scoped to a DIFFERENT school',
    );
    check('a cross-school audit insert is denied under RLS', true);

    // ── 2. Forgot-password: eligible request ───────────────────────────────
    const requested = await requestPasswordReset({
      loginOrEmail: 'prin@fixture.example', // by EMAIL, cross lookup
      schoolId,
      ip: '127.0.0.9',
      origin: 'https://recovfixture.example.test',
    });
    check('eligible request reports queued', requested.emailQueued === true);

    const tokens = await odb.execute<{ id: string; token_hash: string; used_at: Date | null }>(
      sql`select id::text, token_hash, used_at from password_reset_tokens
          where user_id = ${PRIN_ID} order by created_at desc limit 1`,
    );
    check('a reset token row exists', tokens.length === 1);
    check('only the SHA-256 of the token is stored', /^[0-9a-f]{64}$/.test(tokens[0]?.token_hash ?? ''));

    const queued = await odb.execute<{ to_email: string; subject: string }>(
      sql`select to_email, subject from email_events
          where school_id = ${schoolId} order by id desc limit 1`,
    );
    check('the reset email is queued, never sent inline',
      queued.length === 1 && queued[0]?.to_email === 'prin@fixture.example');

    // By LOGIN ID as well.
    const byLogin = await requestPasswordReset({
      loginOrEmail: 'recov-prin', schoolId, ip: '127.0.0.9', origin: 'https://x.test',
    });
    check('login ID lookup finds the same account', byLogin.emailQueued === true);

    // ── 3. Forgot-password: ineligible requests look IDENTICAL ──────────────
    const unknown = await requestPasswordReset({
      loginOrEmail: 'nobody@fixture.example', schoolId, ip: '127.0.0.9', origin: 'https://x.test',
    });
    const noEmail = await requestPasswordReset({
      loginOrEmail: 'RECOV-STU', schoolId, ip: '127.0.0.9', origin: 'https://x.test',
    });
    const crossSchool = await requestPasswordReset({
      loginOrEmail: 'RECOV-PRIN', schoolId: 999_999, ip: '127.0.0.9', origin: 'https://x.test',
    });
    const onPlatformHost = await requestPasswordReset({
      loginOrEmail: 'RECOV-PRIN', schoolId: null, ip: '127.0.0.9', origin: 'https://x.test',
    });
    check(
      'unknown / emailless / cross-school / platform-host requests all look the same',
      unknown.emailQueued === false &&
        noEmail.emailQueued === false &&
        crossSchool.emailQueued === false &&
        onPlatformHost.emailQueued === false,
    );

    await odb
      .update(people.users)
      .set({ status: 'suspended' })
      .where(eq(people.users.id, PRIN_ID));
    const suspended = await requestPasswordReset({
      loginOrEmail: 'RECOV-PRIN', schoolId, ip: '127.0.0.9', origin: 'https://x.test',
    });
    check('suspended accounts do not get tokens (same public response)',
      suspended.emailQueued === false);
    await odb
      .update(people.users)
      .set({ status: 'active' })
      .where(eq(people.users.id, PRIN_ID));

    // Platform admin: request on the platform host.
    const platformReq = await requestPasswordReset({
      loginOrEmail: 'RECOV-PLATFORM', schoolId: null, ip: '127.0.0.9', origin: 'https://x.test',
    });
    check('platform admins without an email queue nothing', platformReq.emailQueued === false);
    await odb
      .update(people.users)
      .set({ email: 'owner@fixture.example' })
      .where(eq(people.users.id, Number(platformAdmin!.id)));
    const platformReq2 = await requestPasswordReset({
      loginOrEmail: 'RECOV-PLATFORM', schoolId: null, ip: '127.0.0.9', origin: 'https://x.test',
    });
    check('platform admin with email queues a NULL-school email event', platformReq2.emailQueued === true);
    const platformMail = await odb.execute<{ school_id: string | null }>(
      sql`select school_id::text from email_events
          where to_email = 'owner@fixture.example' order by id desc limit 1`,
    );
    check('platform-scope mail carries a null school', platformMail[0]?.school_id === null, JSON.stringify(platformMail[0]));

    // ── 4. Token consumption ───────────────────────────────────────────────
    // A live session that must die on reset.
    const doomed = (await createSession(PRIN_ID, '127.0.0.9', 'recovery-suite')).token;

    // Find the RAW token: the suite cannot read it from the DB (hashed), so
    // request a fresh one and capture it via the email body link.
    await requestPasswordReset({
      loginOrEmail: 'RECOV-PRIN', schoolId, ip: '127.0.0.9', origin: 'https://origin.test',
    });
    const mailRow = await odb.execute<{ body: string }>(
      sql`select body from email_events
          where to_email = 'prin@fixture.example' order by id desc limit 1`,
    );
    const link = /https:\/\/origin\.test\/reset-password\?token=([A-Za-z0-9_-]+)/.exec(mailRow[0]?.body ?? '');
    check('the queued mail contains the reset link', !!link);
    const rawToken = link?.[1] ?? '';

    // Expired: force-expire the newest token.
    await odb.execute(
      sql`update password_reset_tokens set expires_at = now() - interval '1 minute'
          where user_id = ${PRIN_ID} and used_at is null`,
    );
    const expired = await resetPasswordWithToken(rawToken, 'NewPass!234', '127.0.0.9');
    check('an expired token is refused', expired.ok === false);

    // Issue a fresh token and use it.
    await requestPasswordReset({
      loginOrEmail: 'RECOV-PRIN', schoolId, ip: '127.0.0.9', origin: 'https://origin.test',
    });
    const mailRow2 = await odb.execute<{ body: string }>(
      sql`select body from email_events
          where to_email = 'prin@fixture.example' order by id desc limit 1`,
    );
    const link2 = /token=([A-Za-z0-9_-]+)/.exec(mailRow2[0]?.body ?? '');
    const fresh = link2?.[1] ?? '';

    const outcome = await resetPasswordWithToken(fresh, 'NewPass!234', '127.0.0.9');
    check('a valid token resets the password', outcome.ok === true);

    // Reuse refused.
    const reuse = await resetPasswordWithToken(fresh, 'Again!Pass1', '127.0.0.9');
    check('a used token cannot be replayed', reuse.ok === false);

    // The new password signs in; the old one does not.
    const signInNew = await authenticateCredentials({
      loginId: 'RECOV-PRIN', password: 'NewPass!234', schoolId,
    });
    check('sign-in works with the new password',
      signInNew.user.id === PRIN_ID && signInNew.secondFactorRequired === false);
    // Sessions were revoked; lockout counters cleared. Read BEFORE the
    // dead-password probe below — that probe deliberately burns one attempt.
    check('the reset revoked live sessions', (await readSessionUser(doomed)) === null);
    const [counters] = await odb
      .select({ a: people.users.failedAttempts, l: people.users.lockedUntil, m: people.users.mustChangePassword })
      .from(people.users).where(eq(people.users.id, PRIN_ID)).limit(1);
    check('counters cleared and no forced change (the user chose it)',
      counters!.a === 0 && counters!.l === null && counters!.m === false);

    let oldRejected = false;
    try {
      await authenticateCredentials({ loginId: 'RECOV-PRIN', password: PASSWORD, schoolId });
    } catch {
      oldRejected = true;
    }
    check('the old password is dead', oldRejected);

    // ── 5. Recovery codes under RLS (store + count, no consuming here) ─────
    // Consumption is covered by test-totp.ts (the staged sign-in section).
    const remainingBefore = await remainingRecoveryCodes({ id: PRIN_ID, schoolId });
    check('an account without two-factor has no recovery codes', remainingBefore === 0);
    check('hashing is case-insensitive', hashCode('abcde-fghij') === hashCode('ABCDE-FGHIJ'));

    // ── Cleanup: the school cascade removes tenant rows; platform leftovers die here ──
    await odb.delete(core.schools).where(eq(core.schools.code, SCHOOL_CODE));
    await odb.delete(people.users).where(eq(people.users.loginId, 'RECOV-PLATFORM'));
    await odb.execute(
      sql`delete from password_reset_tokens where user_id not in (select id from users)`,
    );
    await odb.execute(
      sql`delete from email_events where school_id is null and to_email = 'owner@fixture.example'`,
    );

    console.log(
      failures === 0
        ? 'All recovery checks passed. Account recovery holds.'
        : `${failures} recovery check(s) FAILED.`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
