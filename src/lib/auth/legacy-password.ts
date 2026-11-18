/**
 * Verify a password hash that came from a WordPress site, so a school moved over from the EduCBT Pro plugin
 * keeps every password and nobody has to do anything.
 *
 * WordPress has used four hash styles over the years, and a site can hold a mix of them:
 *   $wp$2y$...   WordPress 6.8+: bcrypt of base64( HMAC-SHA384( password, "wp-sha384" ) )
 *   $2y$ / $2b$  plain bcrypt
 *   $P$ / $H$    phpass (WordPress before 6.8): iterated MD5
 *   32 hex       raw MD5 (very old sites)
 * A hash can NOT be converted into the platform's own Argon2id without the password, so these are verified
 * as they are, and on the first correct sign-in the caller re-hashes the password with Argon2id and replaces
 * the stored value (see upgradeLegacyHash). From then on the account is an ordinary one.
 *
 * Pure functions. No database, no network. Constant-time comparison for everything except bcrypt, which
 * compares internally.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

export type LegacyStyle = 'wp-bcrypt' | 'bcrypt' | 'phpass' | 'md5';

/** Which style a stored hash is, or null when it is not a WordPress hash at all (for example Argon2id). */
export function legacyStyleOf(hash: string): LegacyStyle | null {
  if (typeof hash !== 'string') return null;
  if (/^\$wp\$2[aby]\$\d\d\$/.test(hash) && hash.length === 63) return 'wp-bcrypt';
  if (/^\$2[aby]\$\d\d\$/.test(hash) && hash.length === 60) return 'bcrypt';
  if ((hash.startsWith('$P$') || hash.startsWith('$H$')) && hash.length === 34) return 'phpass';
  if (/^[a-f0-9]{32}$/i.test(hash)) return 'md5';
  return null;
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function encode64(input: Buffer, count: number): string {
  let out = ''; let i = 0;
  do {
    let value = input[i++]!;
    out += ITOA64[value & 0x3f];
    if (i < count) value |= input[i]! << 8;
    out += ITOA64[(value >> 6) & 0x3f];
    if (i++ >= count) break;
    if (i < count) value |= input[i]! << 16;
    out += ITOA64[(value >> 12) & 0x3f];
    if (i++ >= count) break;
    out += ITOA64[(value >> 18) & 0x3f];
  } while (i < count);
  return out;
}

/** phpass "portable" hash, exactly as WordPress's class-phpass.php computes it. */
function phpassCrypt(password: string, setting: string): string {
  const fail = '*0';
  if (!setting.startsWith('$P$') && !setting.startsWith('$H$')) return fail;
  const countLog2 = ITOA64.indexOf(setting[3]!);
  if (countLog2 < 7 || countLog2 > 30) return fail;
  const count = 2 ** countLog2;
  const salt = setting.substring(4, 12);
  if (salt.length !== 8) return fail;
  let hash = createHash('md5').update(salt).update(password, 'utf8').digest();
  for (let i = 0; i < count; i++) hash = createHash('md5').update(hash).update(password, 'utf8').digest();
  return setting.substring(0, 12) + encode64(hash, 16);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * True when `plain` is the password behind `hash`. Never throws: a malformed hash is simply "no".
 * WordPress sometimes stored the password with surrounding spaces removed (when a site used the phpass
 * hasher), so the trimmed form is tried too. That only ever accepts the password the person really set.
 */
export async function verifyLegacyPassword(hash: string, plain: string): Promise<boolean> {
  const style = legacyStyleOf(hash);
  if (!style || typeof plain !== 'string' || plain.length === 0 || plain.length > 4096) return false;
  const candidates = plain === plain.trim() ? [plain] : [plain, plain.trim()];
  for (const p of candidates) {
    if (p.length === 0) continue;
    try {
      if (style === 'wp-bcrypt') {
        const pre = createHmac('sha384', 'wp-sha384').update(p, 'utf8').digest('base64');
        if (await bcrypt.compare(pre, hash.slice(3))) return true;
      } else if (style === 'bcrypt') {
        // bcrypt only reads the first 72 bytes; PHP's password_verify does the same, so this matches it.
        if (await bcrypt.compare(p, hash)) return true;
      } else if (style === 'phpass') {
        if (safeEqual(phpassCrypt(p, hash), hash)) return true;
      } else if (safeEqual(createHash('md5').update(p, 'utf8').digest('hex'), hash.toLowerCase())) return true;
    } catch { /* a malformed hash is a failed login, not an error */ }
  }
  return false;
}

/** A value that may be written to users.password_hash from a WordPress site: a known legacy style only. */
export function isCarryableLegacyHash(hash: unknown): hash is string {
  return typeof hash === 'string' && legacyStyleOf(hash) !== null;
}
