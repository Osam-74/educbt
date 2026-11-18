/**
 * Take a backup of ONE school.
 *
 * Reads happen inside forSchool(), so Postgres row-level security confines every query to
 * that school even if this code had a bug. Credentials are removed here, at the source, so
 * they never exist in memory beside the rest of the export, let alone in the file.
 */
import { sql } from 'drizzle-orm';
import { forSchool } from '@/db';
import {
  DATA_TABLES, SCHOOL_STRIP, USER_STRIP, USER_KEEP_WITH_PASSWORDS, allClassifiedTables,
} from './registry';
import { buildDocument, encode, backupFileName, type BackupDocument } from './format';

const PHOTO_PATH = /^\/api\/photos\/([A-Za-z0-9_-]{10,64})$/;

export type ExportResult = { file: Buffer; fileName: string; counts: Record<string, number>; uploads: number; credentials: 'none' | 'password-hashes' };

/** Binary columns are written as base64 text so the document stays JSON. */
function jsonSafe(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { __bytes: value.toString('base64') };
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function cleanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = jsonSafe(v);
  return out;
}

export type ExportOptions = {
  /** Keep each user's Argon2id password hash so people keep their passwords. Default false: the file carries no credentials. */
  includePasswords?: boolean;
};

export async function exportSchool(schoolId: number, options: ExportOptions = {}): Promise<ExportResult> {
  const includePasswords = options.includePasswords === true;
  const { doc } = await forSchool(schoolId, async (tx) => {
    const schoolRows = await tx.execute(sql`select * from schools where id = ${schoolId}`);
    const school = (schoolRows as unknown as Array<Record<string, unknown>>)[0];
    if (!school) throw new Error('That school does not exist.');

    // The school row without anything that identifies the OLD school: the restore creates a new one.
    const schoolBody = cleanRow(school);
    for (const c of SCHOOL_STRIP) delete schoolBody[c];

    const tables: Record<string, Array<Record<string, unknown>>> = {};
    const uploads: Record<string, { mimeType: string; base64: string }> = {};

    for (const spec of DATA_TABLES) {
      // Identifier comes from our own registry, never from input. Ordered by primary key (or all
      // columns for tables with none) so two backups of unchanged data are byte-identical.
      const order = spec.columns.id ? sql`order by id` : sql``;
      const rows = (await tx.execute(
        sql`select * from ${sql.identifier(spec.table)} where school_id = ${schoolId} ${order}`,
      )) as unknown as Array<Record<string, unknown>>;

      // Second, independent guard. Row-level security protects every table EXCEPT portal_uploads,
      // which has a deliberate public-read policy (photos are served by token). The WHERE clause above
      // is therefore the only barrier on the table holding children's photos, so verify the result
      // instead of trusting it: one foreign row aborts the whole export rather than leaking.
      for (const r of rows) {
        if (Number(r.school_id) !== schoolId) {
          throw new Error(`Backup aborted: ${spec.table} returned a row from another school.`);
        }
      }

      tables[spec.table] = rows.map((r) => {
        const row = cleanRow(r);
        if (spec.table === 'users') {
          for (const c of Object.keys(USER_STRIP)) {
            if (includePasswords && (USER_KEEP_WITH_PASSWORDS as readonly string[]).includes(c)) continue;
            delete row[c];
          }
        }
        for (const [col, rule] of Object.entries(spec.columns)) {
          if (rule.kind === 'strip') delete row[col];
          // The driver hands bigint back as a string. Ids and references are written as numbers so a
          // restore compares like with like. Ids here are sequential and far below 2^53, so this is
          // lossless. `numeric` columns (marks, averages) are deliberately NOT touched: they stay exact
          // decimal strings so a score is never rounded by a float.
          else if ((rule.kind === 'pk' || rule.kind === 'school' || rule.kind === 'ref') && row[col] != null) {
            const n = Number(row[col]);
            if (!Number.isSafeInteger(n)) throw new Error(`${spec.table}.${col} holds an id too large to back up safely.`);
            row[col] = n;
          }
        }
        if (spec.table === 'portal_uploads') {
          // The bytes travel in `uploads`, keyed by the old token, so the token itself is the join key.
          const token = String(r.token);
          const data = r.data as Buffer | null;
          uploads[token] = { mimeType: String(r.mime_type), base64: data ? Buffer.from(data).toString('base64') : '' };
          delete row.data;
        }
        return row;
      });
    }

    const doc: BackupDocument = buildDocument({
      createdAt: new Date().toISOString(),
      app: { name: 'EduCBT', schemaTables: allClassifiedTables().length },
      credentials: includePasswords ? 'password-hashes' : 'none',
      school: schoolBody,
      tables,
      uploads,
    });
    return { doc };
  });

  const file = encode(doc);
  return {
    file,
    fileName: backupFileName(String(doc.school.name ?? 'school'), new Date(), includePasswords),
    counts: doc.counts,
    uploads: Object.keys(doc.uploads).length,
    credentials: doc.credentials,
  };
}

/** Exposed for tests: the token inside a "/api/photos/{token}" path, or null. */
export function photoToken(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  return PHOTO_PATH.exec(path)?.[1] ?? null;
}
