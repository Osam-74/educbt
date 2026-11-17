/**
 * Restore a backup into a NEW school.
 *
 *  - Never overwrites: it always creates a new school, so production data cannot be damaged by a
 *    wrong upload.
 *  - All or nothing: one transaction. Any failure rolls back every row; no half-built school remains.
 *  - The new school is created SUSPENDED and only set active as the very last step.
 *  - Every row gets a brand-new id from the database; every link is remapped (see remap.ts).
 *  - No credentials come from the file. The restored principal gets a fresh temporary password
 *    (returned once, never stored in clear); every other login must set a password on first sign-in.
 */
import { sql } from 'drizzle-orm';
import { asPlatformAdmin, schema } from '@/db';
import { hashPassword, generateInitialPassword } from '@/lib/auth/password';
import { resolveIdPrefix } from '@/lib/platform/schools';
import { decode, type BackupDocument } from './format';
import { DATA_TABLES, SCHOOL_STRIP } from './registry';
import {
  IdMap, RestoreIntegrityError, assertKnownTables, planPhotoTokens, remapRow, remapSchoolSettings, remapVaultPayload,
} from './remap';

export type RestoreInput = {
  actorUserId: number;
  file: Buffer;
  /** the new school's identity: it must not collide with an existing school */
  code: string;
  subdomain?: string | null;
  name?: string;
};

export type RestoreResult = {
  school: { id: number; name: string; code: string; subdomain: string | null };
  principal: { loginId: string; name: string };
  temporaryPassword: string;
  counts: Record<string, number>;
  skipped: string[];
};

type Row = Record<string, unknown>;

/** Columns come from the file, so every identifier is checked against the live schema before use. */
async function liveColumns(tx: Parameters<Parameters<typeof asPlatformAdmin>[2]>[0], table: string): Promise<Set<string>> {
  const rows = (await tx.execute(
    sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table}`,
  )) as unknown as Array<{ column_name: string }>;
  return new Set(rows.map((r) => r.column_name));
}

export async function restoreSchool(input: RestoreInput): Promise<RestoreResult> {
  // 1. Open and verify the file BEFORE touching the database.
  const doc: BackupDocument = decode(input.file);
  assertKnownTables(doc);

  const principalUser = (doc.tables.users ?? []).find((u) => u.role === 'principal');
  if (!principalUser) throw new RestoreIntegrityError('The backup has no principal account, so nobody could sign in to the restored school.');

  // Hashed OUTSIDE the transaction: Argon2 must not hold a pooled connection hostage.
  const temporaryPassword = generateInitialPassword(12);
  const passwordHash = await hashPassword(temporaryPassword);

  const schoolName = (input.name ?? String(doc.school.name ?? '')).trim();
  if (!schoolName) throw new RestoreIntegrityError('The backup has no school name and none was supplied.');

  return asPlatformAdmin(input.actorUserId, `Restore school "${schoolName}" from a backup file`, async (tx) => {
    const ids = new IdMap();
    const counts: Record<string, number> = {};
    const skipped: string[] = [];

    // 2. The new school row: bare, suspended, with the NEW identity. The backup's own identity is
    //    never reused (SCHOOL_STRIP), and nothing is seeded: the backup supplies its own structure.
    const idPrefix = await resolveIdPrefix(tx, schoolName, null);
    const body: Row = { ...doc.school };
    for (const c of SCHOOL_STRIP) delete body[c];
    const [school] = await tx.insert(schema.schools).values({
      name: schoolName,
      code: input.code,
      idPrefix,
      subdomain: input.subdomain ?? null,
      email: (body.email as string | null) ?? null,
      phone: (body.phone as string | null) ?? null,
      address: (body.address as string | null) ?? null,
      website: (body.website as string | null) ?? null,
      principalName: (body.principal_name as string | null) ?? null,
      status: 'suspended',
    }).returning({ id: schema.schools.id, code: schema.schools.code, subdomain: schema.schools.subdomain });
    const newSchoolId = Number(school!.id);

    // Row-level security keys off this setting, so inserts for the new school are legal.
    await tx.execute(sql`select set_config('app.school_id', ${String(newSchoolId)}, true)`);

    // 3. Photos first: new tokens, and the bytes inserted under them.
    const photoTokens = planPhotoTokens(doc);
    for (const [oldToken, up] of Object.entries(doc.uploads)) {
      const bytes = Buffer.from(up.base64, 'base64');
      await tx.insert(schema.portalUploads).values({
        schoolId: newSchoolId, token: photoTokens.get(oldToken)!, mimeType: up.mimeType, byteSize: bytes.length, data: bytes,
      });
    }
    counts.portal_uploads = Object.keys(doc.uploads).length;

    // Emails already in use on the platform must not be re-used (the address is globally unique).
    const taken = new Set(
      ((await tx.execute(sql`select lower(email) as e from users where email is not null`)) as unknown as Array<{ e: string }>).map((r) => r.e),
    );

    // 4. Every table, in dependency order.
    const questionParents: Array<{ oldId: number; oldParent: number }> = [];
    for (const spec of DATA_TABLES) {
      if (spec.table === 'portal_uploads') continue; // restored above, from `uploads`
      const rows = (doc.tables[spec.table] ?? []) as Row[];
      counts[spec.table] = 0;
      if (rows.length === 0) continue;

      const live = await liveColumns(tx, spec.table);
      const hasId = Object.values(spec.columns).some((r) => r.kind === 'pk');

      for (const source of rows) {
        const row = remapRow(spec, source, { newSchoolId, ids, photoTokens, takenEmails: taken });

        if (spec.table === 'question_vault') row.payload = remapVaultPayload(source.payload, ids, newSchoolId);
        if (spec.table === 'questions' && source.parent_id != null) questionParents.push({ oldId: Number(source.id), oldParent: Number(source.parent_id) });

        // Only columns that exist today and have a value; an unknown column in an older file is ignored,
        // never interpolated.
        const cols = Object.keys(row).filter((c) => live.has(c) && row[c] !== undefined);
        const values = cols.map((c) => sql`${toDb(row[c])}`);
        const inserted = (await tx.execute(
          sql`insert into ${sql.identifier(spec.table)} (${sql.join(cols.map((c) => sql.identifier(c)), sql`, `)})
              values (${sql.join(values, sql`, `)}) ${hasId ? sql`returning id` : sql``}`,
        )) as unknown as Array<{ id?: string | number }>;

        if (hasId && source.id != null && inserted[0]?.id != null) ids.set(spec.table, Number(source.id), Number(inserted[0].id));
        counts[spec.table]!++;
        if (spec.table === 'users' && row.email) taken.add(String(row.email).toLowerCase());
      }
    }

    // 5. Second pass: a question's parent could not be known until every question existed.
    for (const { oldId, oldParent } of questionParents) {
      const newId = ids.get('questions', oldId); const newParent = ids.get('questions', oldParent);
      if (newId !== undefined && newParent !== undefined) {
        await tx.execute(sql`update questions set parent_id = ${newParent} where id = ${newId} and school_id = ${newSchoolId}`);
      } else skipped.push(`question #${oldId} lost its parent link (the parent was not in the backup)`);
    }

    // 6. The photos' paths were rewritten above; the school's own logo and principal photo too.
    const logo = doc.school.logo_url as string | null; const pPhoto = doc.school.principal_photo_url as string | null;
    const settings = remapSchoolSettings(doc.school.settings, ids);
    const rewrite = (p: string | null) => (p && /^\/api\/photos\//.test(p) ? (photoTokens.get(p.split('/').pop()!) ? `/api/photos/${photoTokens.get(p.split('/').pop()!)}` : null) : p);
    await tx.execute(sql`update schools set logo_url = ${rewrite(logo)}, principal_photo_url = ${rewrite(pPhoto)}, settings = ${JSON.stringify(settings ?? {})}::jsonb where id = ${newSchoolId}`);

    // 7. The principal: the restored account gets a fresh temporary password and must change it.
    const principalId = ids.get('users', Number(principalUser.id));
    if (principalId === undefined) throw new RestoreIntegrityError('The principal account could not be restored.');
    await tx.execute(sql`update users set password_hash = ${passwordHash}, must_change_password = true, status = 'active' where id = ${principalId} and school_id = ${newSchoolId}`);
    const [pu] = (await tx.execute(sql`select login_id from users where id = ${principalId}`)) as unknown as Array<{ login_id: string }>;
    const principalStaff = (doc.tables.staff ?? []).find((s) => Number(s.user_id) === Number(principalUser.id));
    const principalName = principalStaff ? `${principalStaff.first_name} ${principalStaff.last_name}` : String(doc.school.principal_name ?? 'Principal');

    // 8. Record it, then (last of all) open the school.
    await tx.insert(schema.auditLog).values({
      schoolId: newSchoolId, actorUserId: input.actorUserId, actorRole: 'platform_admin', action: 'school.restored_from_backup',
      entityType: 'schools', entityId: newSchoolId,
      after: { name: schoolName, backupCreatedAt: doc.createdAt, counts } as never,
    });
    await tx.execute(sql`update schools set status = 'active', updated_at = now() where id = ${newSchoolId}`);

    return {
      school: { id: newSchoolId, name: schoolName, code: String(school!.code), subdomain: (school!.subdomain as string | null) ?? null },
      principal: { loginId: String(pu!.login_id), name: principalName },
      temporaryPassword, counts, skipped,
    };
  });
}

/** Values that must reach Postgres as JSON (objects/arrays) or bytes; everything else passes through. */
function toDb(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v) && '__bytes' in (v as object)) return Buffer.from((v as { __bytes: string }).__bytes, 'base64');
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
