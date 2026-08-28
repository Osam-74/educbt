/**
 * Authentication.
 *
 * Auth.js v5 with a Credentials provider over our own users table. The login
 * identifier is unique WITHIN a school, so resolving an account needs both the
 * tenant and the identifier — which is why the school is resolved from the
 * hostname before this ever runs.
 *
 * Sessions are database-backed, not JWT. A student suspended mid-morning must
 * lose access on their next request; with a stateless token they would keep it
 * until expiry, which during an examination is precisely wrong.
 */

import NextAuth, { type DefaultSession } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '@/db';
import { verifyPassword } from '@/lib/auth/password';
import { checkLoginThrottle, lockoutUntil } from '@/lib/auth/throttle';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      schoolId: number | null;
      role: string;
      loginId: string;
      mustChangePassword: boolean;
      staffId: number | null;
      studentId: number | null;
    } & DefaultSession['user'];
  }
}

const credentialsSchema = z.object({
  loginId: z.string().min(1).max(191),
  password: z.string().min(1).max(200),
  schoolId: z.coerce.number().int().positive().nullable().optional(),
  ip: z.string().optional(),
});

/**
 * Deliberately vague. "No account with that admission number" tells an attacker
 * which numbers exist; the same message for every failure tells them nothing.
 */
const GENERIC_FAILURE = 'Those sign-in details were not recognised.';

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: 'database',
    maxAge: 60 * 60 * 12, // A school day, not a fortnight.
  },
  pages: {
    signIn: '/sign-in',
  },
  providers: [
    Credentials({
      credentials: {
        loginId: { label: 'Admission or staff number' },
        password: { label: 'Password', type: 'password' },
        schoolId: {},
      },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);

        if (!parsed.success) return null;

        const { loginId, password, schoolId, ip } = parsed.data;

        // Throttle BEFORE touching the database, so a flood of guesses costs the
        // attacker a Redis call rather than a Postgres query and an Argon2 hash.
        const throttle = await checkLoginThrottle(ip ?? 'unknown', schoolId ?? null, loginId);

        if (!throttle.allowed) {
          throw new Error(
            `Too many attempts. Try again in ${throttle.retryAfterSeconds ?? 60} seconds.`,
          );
        }

        const [user] = await db
          .select()
          .from(schema.users)
          .where(
            schoolId
              ? and(eq(schema.users.schoolId, schoolId), eq(schema.users.loginId, loginId))
              : and(eq(schema.users.loginId, loginId), eq(schema.users.role, 'platform_admin')),
          )
          .limit(1);

        if (!user) {
          // Hash anyway. Returning immediately makes a missing account faster
          // than a wrong password, and that timing difference is enough to
          // enumerate valid admission numbers.
          await verifyPassword(
            '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            password,
          );
          throw new Error(GENERIC_FAILURE);
        }

        if (user.lockedUntil && user.lockedUntil > new Date()) {
          const secs = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
          throw new Error(`This account is locked. Try again in ${secs} seconds.`);
        }

        if (user.status !== 'active') {
          // Says nothing about whether the password was right.
          throw new Error('This account is not active. Please contact the school office.');
        }

        const ok = await verifyPassword(user.passwordHash, password);

        if (!ok) {
          const attempts = user.failedAttempts + 1;

          await db
            .update(schema.users)
            .set({ failedAttempts: attempts, lockedUntil: lockoutUntil(attempts) })
            .where(eq(schema.users.id, user.id));

          throw new Error(GENERIC_FAILURE);
        }

        await db
          .update(schema.users)
          .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
          .where(eq(schema.users.id, user.id));

        // The staff or student row this account speaks for. Authorisation is
        // scoped through these, not through the role name alone.
        const [staffRow] = user.schoolId
          ? await db.select({ id: schema.staff.id }).from(schema.staff)
              .where(eq(schema.staff.userId, user.id)).limit(1)
          : [];

        const [studentRow] = user.schoolId
          ? await db.select({ id: schema.students.id }).from(schema.students)
              .where(eq(schema.students.userId, user.id)).limit(1)
          : [];

        return {
          id: String(user.id),
          schoolId: user.schoolId,
          role: user.role,
          loginId: user.loginId,
          mustChangePassword: user.mustChangePassword,
          staffId: staffRow?.id ?? null,
          studentId: studentRow?.id ?? null,
        };
      },
    }),
  ],
  callbacks: {
    session({ session, user }) {
      // Everything downstream reads the tenant from HERE, never from a request
      // parameter. A user who edits ?school_id in the URL changes nothing.
      Object.assign(session.user, user);
      return session;
    },
  },
});
