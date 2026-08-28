/**
 * Password handling.
 *
 * Argon2id, not bcrypt. Bcrypt silently truncates at 72 bytes and its work
 * factor no longer tracks modern hardware well.
 */

import { hash, verify } from '@node-rs/argon2';

/**
 * OWASP-recommended parameters: 19 MiB, 2 iterations, 1 degree of parallelism.
 *
 * Memory cost is what makes GPU cracking expensive. Do not lower it to speed up
 * a login screen — a login takes tens of milliseconds and happens once a day; an
 * offline crack against a leaked table happens billions of times.
 */
const OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }

  return hash(plain, OPTIONS);
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashValue, plain, OPTIONS);
  } catch {
    // A malformed hash is a failed login, not a 500. Returning false keeps the
    // timing and the response identical to a wrong password, so this path
    // cannot be used to probe which accounts have broken hashes.
    return false;
  }
}

/**
 * Initial passwords issued by the school office.
 *
 * No self-service email reset for students: most have no email, and the office
 * is the identity authority. Excludes characters that are misread off a printed
 * slip — O/0, I/l/1 — because a credential nobody can type is a support call.
 */
export function generateInitialPassword(length = 10): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);

  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }

  return out;
}
