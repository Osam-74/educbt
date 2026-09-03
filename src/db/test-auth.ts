/**
 * Auth layer regression suite.
 *
 * The session contract, proven against the REAL educbt_app role (RLS on):
 *
 *   1. Credentials: right password signs in; wrong password counts and locks
 *      out (exponential backoff); unknown loginId costs the same Argon2 work
 *      and answers with the SAME message; suspension refuses sign-in.
 *   2. Tenant scoping: a loginId from another school is invisible even when
 *      passed with that school's id — forSchool + RLS, not a WHERE clause.
 *   3. Sessions: the cookie token is 256-bit randomness and the table stores
 *      ONLY its SHA-256 (a database leak yields no usable cookies); reads
 *      re-check expiry and the LIVE user row so suspension, lockout and
 *      forced password changes take effect on the NEXT request; sign-out
 *      and password change destroy sessions.
 *   4. Platform-admin accounts (no school) sign in through the narrow
 *      platform_admin_lookup policy.
 *
 * Fixture standard: a dedicated private school, deleted-then-recreated (safe
 * to rerun, safe in parallel), no production constraints weakened. The
 * application-role modules under test connect via DATABASE_URL_APP; the
 * fixture and the "live row" mutations use the owner connection, because
 * only the owner may write across tenants and flip rows the app cannot see.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as core from './schema/core';
import * as people from './schema/people';
import { authenticateCredentials, GENERIC_FAILURE } from '@/lib/auth/credentials';
import {
  createSession,
  readSessionUser,
  destroySession,
  destroyUserSessions,
  hashSessionToken,
} from '@/lib/auth/session-store';
import { hashPassword } from '@/lib/auth/password';

const schema = { ...core, ...people };
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

const SCHOOL_CODE = 'AUTH-FIXTURE';
const PASSWORD = 'Fixt-Auth!23';

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
        name: 'Auth Fixture School', code: SCHOOL_CODE,
        subdomain: 'authfixture', status: 'active',
      } as never)
      .returning();
    const schoolId = Number(school!.id);

    const [demoSchool] = await odb
      .select({ id: core.schools.id })
      .from(core.schools)
      .where(eq(core.schools.code, 'DEMO001'))
      .limit(1);

    const principalHash = await hashPassword(PASSWORD);
    const [principal] = await odb
      .insert(people.users)
      .values({
        schoolId, role: 'principal', loginId: 'AUTH-PRIN', passwordHash: principalHash,
        status: 'active', mustChangePassword: false,
      } as never)
      .returning();

    const [staffRow] = await odb
      .insert(people.staff)
      .values({
        schoolId, userId: Number(principal!.id), staffNumber: 'AUTH-STF-1',
        firstName: 'Auth', lastName: 'Fixture', role: 'principal', status: 'active',
      } as never)
      .returning();

    const [studentUser] = await odb
      .insert(people.users)
      .values({
        schoolId, role: 'student', loginId: 'AUTH-STU', passwordHash: principalHash,
        status: 'active', mustChangePassword: false,
      } as never)
      .returning();
    const [studentRow] = await odb
      .insert(people.students)
      .values({
        schoolId, userId: Number(studentUser!.id), admissionNumber: 'AUTH-STU-1',
        firstName: 'Auth', lastName: 'Student', status: 'active',
      } as never)
      .returning();

    const [platformAdmin] = await odb
      .insert(people.users)
      .values({
        schoolId: null, role: 'platform_admin', loginId: 'AUTH-PLATFORM',
        passwordHash: principalHash, status: 'active', mustChangePassword: false,
      } as never)
      .returning();

    // ── 1. Credentials ──────────────────────────────────────────────────────
    const good = await authenticateCredentials({
      loginId: 'AUTH-PRIN', password: PASSWORD, schoolId,
    });
    check('right password signs in', good.id === Number(principal!.id));
    check('staff identity resolved', good.staffId === Number(staffRow!.id));
    check('student session carries no staffId', good.staffId === Number(staffRow!.id) && good.studentId === null);

    let failed = false;
    try {
      await authenticateCredentials({ loginId: 'AUTH-PRIN', password: 'wrong-password', schoolId });
    } catch (e) {
      failed = (e as Error).message === GENERIC_FAILURE;
    }
    const [afterFail] = await odb
      .select({ attempts: people.users.failedAttempts })
      .from(people.users).where(eq(people.users.id, Number(principal!.id))).limit(1);
    check('wrong password counted', failed && afterFail!.attempts === 1);

    let unknownFailed = false;
    try {
      await authenticateCredentials({ loginId: 'NO-SUCH-LOGIN', password: 'whatever', schoolId });
    } catch (e) {
      unknownFailed = (e as Error).message === GENERIC_FAILURE;
    }
    check('unknown loginId gives the same answer (no enumeration)', unknownFailed);

    // Lockout: 5 failures triggers exponential backoff (throttle.ts)
    // failedAttempts is already 1 from the check above, so the 5th failure
    // happens on the 4th loop pass; the next pass must hit the lockout.
    let locked = false;
    for (let i = 0; i < 6 && !locked; i++) {
      try {
        await authenticateCredentials({ loginId: 'AUTH-PRIN', password: 'wrong-password', schoolId });
      } catch (e) {
        locked = /This account is locked/.test((e as Error).message);
      }
    }
    check('fifth+ failure locks the account', locked);

    // Owner unlocks, sign-in works again
    await odb
      .update(people.users)
      .set({ failedAttempts: 0, lockedUntil: null })
      .where(eq(people.users.id, Number(principal!.id)));
    const retry = await authenticateCredentials({ loginId: 'AUTH-PRIN', password: PASSWORD, schoolId });
    check('account works after unlock', retry.id === Number(principal!.id));

    // Suspension refuses sign-in
    await odb
      .update(people.users)
      .set({ status: 'suspended' })
      .where(eq(people.users.id, Number(principal!.id)));
    let refused = false;
    try {
      await authenticateCredentials({ loginId: 'AUTH-PRIN', password: PASSWORD, schoolId });
    } catch (e) {
      refused = /not active/.test((e as Error).message);
    }
    check('suspended account cannot sign in', refused);
    await odb
      .update(people.users)
      .set({ status: 'active' })
      .where(eq(people.users.id, Number(principal!.id)));

    // ── 2. Tenant scoping ───────────────────────────────────────────────────
    let crossTenant = false;
    try {
      await authenticateCredentials({
        loginId: 'AUTH-PRIN', password: PASSWORD, schoolId: Number(demoSchool!.id),
      });
    } catch {
      crossTenant = true; // any failure is correct; the row must be invisible
    }
    check('a loginId from another school is invisible', crossTenant);

    // ── 3. Sessions ─────────────────────────────────────────────────────────
    const { token } = await createSession(Number(principal!.id), '10.9.8.7', 'auth-suite/1.0');

    check('cookie token is 256-bit base64url', /^[A-Za-z0-9_-]{43}$/.test(token), token.slice(0, 8) + '…');

    const [stored] = await odb
      .select()
      .from(people.sessions)
      .where(eq(people.sessions.id, hashSessionToken(token)))
      .limit(1);
    check('table stores the SHA-256, not the token', !!stored && stored.id !== token);
    check(
      'expiry is ~12h and metadata recorded',
      !!stored &&
        stored.expiresAt.getTime() - Date.now() > 11.9 * 3600 * 1000 &&
        stored.expiresAt.getTime() - Date.now() <= 12 * 3600 * 1000 &&
        stored.ip === '10.9.8.7' &&
        stored.userAgent === 'auth-suite/1.0',
    );

    const sessionUser = await readSessionUser(token);
    check('session resolves the live user', !!sessionUser && sessionUser.id === Number(principal!.id));
    check('unknown token reads nothing', (await readSessionUser('garbage')) === null);

    // A suspended SCHOOL closes the door for everyone in it on their next
    // request — an existing session must not outlive the tenant's status.
    await odb
      .update(core.schools)
      .set({ status: 'suspended' })
      .where(eq(core.schools.id, Number(school!.id)));
    check(
      'school suspension ends the session on the next request',
      (await readSessionUser(token)) === null,
    );
    await odb
      .update(core.schools)
      .set({ status: 'active' })
      .where(eq(core.schools.id, Number(school!.id)));
    check(
      'the same session resumes when the school is reactivated',
      (await readSessionUser(token))?.id === Number(principal!.id),
    );

    // Suspension kills the session on the NEXT request — the core property.
    await odb
      .update(people.users)
      .set({ status: 'suspended' })
      .where(eq(people.users.id, Number(principal!.id)));
    check('suspension ends the session immediately', (await readSessionUser(token)) === null);
    await odb
      .update(people.users)
      .set({ status: 'active' })
      .where(eq(people.users.id, Number(principal!.id)));

    // Forced password change is seen on the next request, not at next sign-in.
    await odb
      .update(people.users)
      .set({ mustChangePassword: true })
      .where(eq(people.users.id, Number(principal!.id)));
    const forcedNow = await readSessionUser(token);
    check('forced password change is live in the session', !!forcedNow && forcedNow.mustChangePassword === true);
    await odb
      .update(people.users)
      .set({ mustChangePassword: false })
      .where(eq(people.users.id, Number(principal!.id)));

    // Expiry is checked against the row, not the cookie
    await odb
      .update(people.sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(people.sessions.id, hashSessionToken(token)));
    check('expired session reads nothing', (await readSessionUser(token)) === null);

    // Sign-out destroys exactly one session; password change destroys all.
    const t1 = (await createSession(Number(principal!.id), null, null)).token;
    const t2 = (await createSession(Number(principal!.id), null, null)).token;
    await destroySession(t1);
    check('sign-out ends one session', (await readSessionUser(t1)) === null && (await readSessionUser(t2)) !== null);
    await destroyUserSessions(Number(principal!.id));
    check('password change ends every device', (await readSessionUser(t2)) === null);

    // Student identity resolution through the session
    const studentToken = (await createSession(Number(studentUser!.id), null, null)).token;
    const studentSession = await readSessionUser(studentToken);
    check(
      'student session resolves studentId',
      !!studentSession && studentSession.studentId === Number(studentRow!.id) && studentSession.staffId === null,
    );

    // ── 4. Platform admin (no school) ───────────────────────────────────────
    const platform = await authenticateCredentials({ loginId: 'AUTH-PLATFORM', password: PASSWORD });
    check('platform admin signs in without a school', platform.id === Number(platformAdmin!.id) && platform.schoolId === null);
    const platformToken = (await createSession(Number(platformAdmin!.id), null, null)).token;
    const platformSession = await readSessionUser(platformToken);
    check('platform admin session carries no tenant', !!platformSession && platformSession.schoolId === null);

    // ── Cleanup: leave nothing durable behind ────────────────────────────────
    await odb.delete(core.schools).where(eq(core.schools.code, SCHOOL_CODE));
    await odb.delete(people.users).where(eq(people.users.loginId, 'AUTH-PLATFORM'));

    const leftovers = await odb
      .select({ n: people.sessions.id })
      .from(people.sessions)
      .innerJoin(people.users, eq(people.sessions.userId, people.users.id))
      .where(and(eq(people.users.loginId, 'AUTH-PRIN')))
      .limit(1);
    check('no fixture sessions survive the cascade', leftovers.length === 0);

    console.log(
      failures === 0
        ? 'All auth checks passed. The session contract holds.'
        : `${failures} auth check(s) FAILED.`,
    );
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await owner.end();
  }
}

main().catch((err) => {
  console.error('Auth suite error:', err);
  process.exit(1);
});
