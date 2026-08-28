/**
 * Login throttling.
 *
 * Admission numbers are sequential: 2025010203 is followed by 2025010204. That
 * makes enumeration trivial in a way an email address is not, so throttling here
 * is doing real work rather than ticking a box.
 *
 * Two independent limits:
 *
 *   by IP        stops one machine walking the whole admission range
 *   by identity  stops a distributed attempt at one known account
 *
 * Plus per-account lockout with exponential backoff in the users table, which
 * survives a Redis outage. If Upstash is unreachable the limiter fails OPEN —
 * a rate limiter must never be the reason a school cannot start its exam — but
 * the database lockout still applies, so the account is not left undefended.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const configured = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

const redis = configured ? Redis.fromEnv() : null;

const byIp = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(20, '10 m'),
      prefix: 'login:ip',
      analytics: false,
    })
  : null;

const byIdentity = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(8, '10 m'),
      prefix: 'login:id',
      analytics: false,
    })
  : null;

export type ThrottleResult = { allowed: boolean; retryAfterSeconds?: number };

export async function checkLoginThrottle(
  ip: string,
  schoolId: number | null,
  loginId: string,
): Promise<ThrottleResult> {
  if (!byIp || !byIdentity) {
    // Not configured, or Redis is down. See the note above on failing open.
    return { allowed: true };
  }

  try {
    const identityKey = `${schoolId ?? 'platform'}:${loginId.toLowerCase()}`;

    const [ipResult, idResult] = await Promise.all([
      byIp.limit(ip),
      byIdentity.limit(identityKey),
    ]);

    if (!ipResult.success || !idResult.success) {
      const reset = Math.max(ipResult.reset, idResult.reset);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
      };
    }

    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

/**
 * Per-account lockout, doubling with each group of failures.
 *
 * A flat "5 attempts then blocked" is easy to wait out. Doubling makes a
 * sustained attempt expensive while barely inconveniencing a teacher who
 * mistyped their password twice.
 *
 *   5 failures  →  1 minute
 *   6           →  2 minutes
 *   7           →  4 minutes
 *   ...capped at 1 hour, so a locked-out teacher is never stranded for a day.
 */
export function lockoutUntil(failedAttempts: number): Date | null {
  if (failedAttempts < 5) return null;

  const minutes = Math.min(60, 2 ** (failedAttempts - 5));
  return new Date(Date.now() + minutes * 60_000);
}
