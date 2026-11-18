/**
 * The id-remapping rules of a restore. Pure: no database, so every rule is unit-tested.
 *
 * A restored school gets brand-new ids for every row. Everything that pointed at an old id must
 * point at the matching NEW id, or the school is silently corrupt (a result attached to the wrong
 * student is worse than a missing one). This file is where that is decided, in one place.
 */
import { randomBytes } from 'node:crypto';
import { DATA_TABLES, USER_STRIP, UNUSABLE_PASSWORD_PREFIX, ARGON2ID_HASH, type TableSpec } from './registry';
import { isCarryableLegacyHash } from '@/lib/auth/legacy-password';
import type { BackupDocument } from './format';

export class RestoreIntegrityError extends Error {}

/** old id -> new id, per table. */
export class IdMap {
  private readonly maps = new Map<string, Map<number, number>>();
  set(table: string, oldId: number, newId: number) {
    let m = this.maps.get(table);
    if (!m) { m = new Map(); this.maps.set(table, m); }
    m.set(oldId, newId);
  }
  get(table: string, oldId: number): number | undefined { return this.maps.get(table)?.get(oldId); }
  size(table: string): number { return this.maps.get(table)?.size ?? 0; }
}

/** A new, unguessable photo token. Same alphabet and length family as the app's own tokens. */
export function newPhotoToken(): string { return randomBytes(24).toString('base64url'); }

const PHOTO_PATH = /^\/api\/photos\/([A-Za-z0-9_-]{10,64})$/;

/** Rewrite "/api/photos/{old}" to "/api/photos/{new}" using the old->new token map. Other values pass through. */
export function rewritePhotoPath(value: unknown, tokenMap: Map<string, string>): unknown {
  if (typeof value !== 'string') return value;
  const m = PHOTO_PATH.exec(value);
  if (!m) return value;
  const next = tokenMap.get(m[1]!);
  // The photo path points at a photo the backup does not contain: drop the dangling link rather
  // than keep a broken image that points at nothing (or at someone else's upload).
  return next ? `/api/photos/${next}` : null;
}

/**
 * Make one row ready to insert for the new school.
 * Throws RestoreIntegrityError when a required reference cannot be resolved: a row that points at
 * a row that is not in the backup means the file is inconsistent, and restoring it would corrupt data.
 */
export function remapRow(
  spec: TableSpec,
  row: Record<string, unknown>,
  ctx: { newSchoolId: number; ids: IdMap; photoTokens: Map<string, string>; takenEmails?: ReadonlySet<string>; credentials?: 'none' | 'password-hashes' | 'wordpress-hashes' },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };

  for (const [col, rule] of Object.entries(spec.columns)) {
    switch (rule.kind) {
      case 'pk': delete out[col]; break; // the database assigns the new id
      case 'school': out[col] = ctx.newSchoolId; break;
      case 'strip': out[col] = rule.value === '__new_token__' ? undefined : rule.value; break;
      case 'photo': out[col] = rewritePhotoPath(row[col], ctx.photoTokens); break;
      case 'ref': {
        const old = row[col];
        if (old === null || old === undefined) {
          if (!rule.nullable) throw new RestoreIntegrityError(`${spec.table}.${col} is empty but must point at a ${rule.table}.`);
          out[col] = null; break;
        }
        if (rule.table === spec.table) { out[col] = null; break; } // self-reference: patched in a second pass
        const mapped = ctx.ids.get(rule.table, Number(old));
        if (mapped === undefined) {
          // A nullable link to something that is not in the file is cleared (e.g. a staff member who was
          // deleted before the backup). A REQUIRED link that cannot be resolved is a broken file.
          if (rule.nullable) { out[col] = null; break; }
          throw new RestoreIntegrityError(`${spec.table}.${col} points at ${rule.table} #${old}, which is not in the backup.`);
        }
        out[col] = mapped; break;
      }
    }
  }

  if (spec.table === 'users') {
    Object.assign(out, USER_STRIP);
    out.password_hash = UNUSABLE_PASSWORD_PREFIX + randomBytes(16).toString('hex'); // unique, never verifiable
    // A file that declares password hashes may keep them, but ONLY a genuine Argon2id hash. A missing,
    // hand-edited or weak value (plaintext, md5, anything else) falls back to the unusable placeholder,
    // so a tampered file cannot smuggle in a credential that is weaker than the app would ever create.
    // Two-factor secrets, lock-out state and the like were reset by USER_STRIP above either way.
    if (ctx.credentials === 'password-hashes') {
      const kept = row.password_hash;
      if (typeof kept === 'string' && ARGON2ID_HASH.test(kept)) {
        out.password_hash = kept;
        if (typeof row.must_change_password === 'boolean') out.must_change_password = row.must_change_password;
      }
    }
    // A file made by the plugin translator may carry WordPress hashes, and ONLY those: a recognised WordPress
    // style (never plaintext, never a stripped or invented value). A SaaS backup can never reach this branch,
    // because only the translator writes 'wordpress-hashes', so a tampered SaaS file stays limited to Argon2id.
    // The person is not forced to change anything: sign-in verifies the hash and upgrades it silently.
    if (ctx.credentials === 'wordpress-hashes') {
      const kept = row.password_hash;
      if (isCarryableLegacyHash(kept)) {
        out.password_hash = kept; out.must_change_password = false; out.password_carried_at = new Date().toISOString();
      } else if (typeof kept === 'string' && ARGON2ID_HASH.test(kept)) {
        out.password_hash = kept; out.must_change_password = false;
      }
    }
    // A restored sign-in must never carry a credential, and an email already used by a live account
    // elsewhere is cleared instead of colliding (login_id still works).
    const email = typeof out.email === 'string' ? out.email.toLowerCase() : null;
    if (email && ctx.takenEmails?.has(email)) { out.email = null; out.email_verified_at = null; }
  }

  if (spec.table === 'announcements') out.audience_ref = remapAudienceRef(row, ctx.ids);

  return out;
}

/** announcements.audience_ref points at a class, level or department depending on `audience`. */
export function remapAudienceRef(row: Record<string, unknown>, ids: IdMap): unknown {
  const ref = row.audience_ref;
  if (ref === null || ref === undefined) return null;
  const table = ({ class: 'classes', level: 'class_levels', department: 'departments' } as Record<string, string>)[String(row.audience)];
  if (!table) return ref; // e.g. audience "role": the ref is a role word, not an id
  const mapped = ids.get(table, Number(ref));
  return mapped === undefined ? null : mapped;
}

/** The new id for every old photo token. */
export function planPhotoTokens(doc: BackupDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const oldToken of Object.keys(doc.uploads)) map.set(oldToken, newPhotoToken());
  return map;
}

/**
 * schools.settings can carry ids (questionBank.seriesId points at an exam series). Rewrite the ones
 * we know about; a series that is not in the backup clears the setting instead of pointing at
 * another school's series.
 */
export function remapSchoolSettings(settings: unknown, ids: IdMap): unknown {
  if (!settings || typeof settings !== 'object') return settings;
  const next = structuredClone(settings) as Record<string, unknown>;
  const qb = next.questionBank as Record<string, unknown> | undefined;
  if (qb && typeof qb === 'object' && qb.seriesId != null) {
    const mapped = ids.get('exam_series', Number(qb.seriesId));
    if (mapped === undefined) delete qb.seriesId; else qb.seriesId = mapped;
  }
  return next;
}

/**
 * The question vault stores whole questions as JSON, with their OLD ids inside. After a restore
 * those ids point at nothing, so a "restore this set" would write rows with the wrong ids. Rewrite
 * the ids it embeds that we can map; leave the rest of the snapshot untouched.
 */
export function remapVaultPayload(payload: unknown, ids: IdMap, newSchoolId: number): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const p = structuredClone(payload) as { setId?: number; questions?: Array<{ row?: Record<string, unknown>; options?: Array<Record<string, unknown>> }> };
  if (typeof p.setId === 'number') {
    const m = ids.get('question_sets', p.setId);
    if (m !== undefined) p.setId = m;
  }
  const refCols: Array<[string, string]> = [['question_set_id', 'question_sets'], ['passage_id', 'passages']];
  for (const q of p.questions ?? []) {
    if (q.row) {
      const oldId = Number(q.row.id);
      const newId = ids.get('questions', oldId);
      if (newId !== undefined) q.row.id = newId;
      if ('school_id' in q.row) q.row.school_id = newSchoolId;
      for (const [col, table] of refCols) {
        if (q.row[col] != null) { const m = ids.get(table, Number(q.row[col])); q.row[col] = m ?? null; }
      }
      if (q.row.parent_id != null) { const m = ids.get('questions', Number(q.row.parent_id)); q.row.parent_id = m ?? null; }
      if (q.row.reviewed_by != null) { const m = ids.get('users', Number(q.row.reviewed_by)); q.row.reviewed_by = m ?? null; }
    }
    for (const o of q.options ?? []) {
      if ('school_id' in o) o.school_id = newSchoolId;
      const oid = ids.get('question_options', Number(o.id)); if (oid !== undefined) o.id = oid;
      const qid = ids.get('questions', Number(o.question_id)); if (qid !== undefined) o.question_id = qid;
    }
  }
  return p;
}

/** Every table in the file must be one we know how to restore; an unknown table means a newer/foreign file. */
export function assertKnownTables(doc: BackupDocument): void {
  const known = new Set(DATA_TABLES.map((t) => t.table));
  const unknown = Object.keys(doc.tables).filter((t) => !known.has(t));
  if (unknown.length) throw new RestoreIntegrityError(`The backup contains tables this version cannot restore: ${unknown.join(', ')}.`);
}
