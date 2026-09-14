/**
 * TOTP two-factor codes — RFC 6238, implemented on node:crypto alone.
 *
 * No next/* imports so the whole thing is regression-testable from plain
 * scripts (src/db/test-totp.ts), including the RFC's own test vectors.
 *
 * Rules that must never regress:
 *   - HMAC-SHA1, 30-second step, 6 digits — the exact profile Google
 *     Authenticator / Authy / 1Password provision from an otpauth:// URI.
 *   - The comparison is constant-time. A timing side-channel on a 6-digit
 *     code is narrow but the fix is free.
 *   - Verification accepts the previous and next step (±30s). Authenticator
 *     apps drift, wall clocks on exam-room PCs drift more.
 *   - The secret never appears in a log, a return value or an error.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 4648 base32, as every authenticator app reads it: uppercase, no padding.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Encode bytes as the base32 an authenticator app expects in manual entry. */
function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/** Decode base32 exactly as written above; throws on any other character. */
function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error('bad base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** A fresh 160-bit secret — the length every authenticator app provisions. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The provisioning URI an authenticator app turns into an account. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The 6-digit code for a step counter (seconds / 30). */
function totpAt(secretBytes: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);

  const digest = createHmac('sha1', secretBytes).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    (((digest[offset]! & 0x7f) << 24)
      | (digest[offset + 1]! << 16)
      | (digest[offset + 2]! << 8)
      | digest[offset + 3]!) % 1_000_000;

  return String(code).padStart(6, '0');
}

/** Constant-time 6-digit comparison. */
function codesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Verify a code against a secret at the current time, allowing one step of
 * clock drift either way. `now` is a parameter so tests use the RFC vectors.
 */
export function verifyTotp(secret: string, code: string, now: Date = new Date()): boolean {
  if (!/^\d{6}$/.test(code)) return false;

  let secretBytes: Buffer;
  try {
    secretBytes = base32Decode(secret);
  } catch {
    return false;
  }

  const step = Math.floor(now.getTime() / 1000 / 30);

  // ±1 step. A match stops further comparisons — but every branch compares
  // constant-time, so the timing story is uniform either way.
  for (const candidate of [step - 1, step, step + 1]) {
    if (candidate < 0) continue;
    if (codesMatch(totpAt(secretBytes, candidate), code)) return true;
  }

  return false;
}

/** The code a correctly-set authenticator shows right now (tests and dev only). */
export function currentTotpCode(secret: string, now: Date = new Date()): string {
  return totpAt(base32Decode(secret), Math.floor(now.getTime() / 1000 / 30));
}
