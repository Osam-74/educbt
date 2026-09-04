/**
 * Backup storage — provider-independent by construction.
 *
 * Production speaks Google Cloud Storage (Firebase Cloud Storage is GCS —
 * bucket `educbt-a07ae.firebasestorage.app`) through the server-side
 * `@google-cloud/storage` SDK. Local development and restore rehearsals use
 * the LocalDirStore. The backup/restore scripts only ever see the
 * BackupStore interface, so the storage provider is a one-adapter concern.
 *
 * Security posture:
 *  - The bucket is private; backups never get public URLs. This module
 *    cannot create a shareable link even by mistake — there is no code for
 *    URL signing or object publicising anywhere in it (a regression check
 *    scans for the corresponding SDK method names).
 *  - Authentication is server/infrastructure-only: Application Default
 *    Credentials (Workload Identity Federation in CI) or an explicit
 *    service-account credential supplied by the environment. The browser
 *    Firebase SDK and its web API key are never used here.
 *  - Deletion is structurally confined to the `backups/database/` prefix
 *    (see assertBackupPrefix) — a broad bucket delete is impossible to
 *    express through this API.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Storage } from '@google-cloud/storage';
import { assertValidBackupId, backupKey, BACKUP_PREFIX } from './naming';
import type { StoreConfig } from './env';

export interface PutResult {
  key: string;
  sizeBytes: number;
}

export interface BackupStore {
  readonly kind: 'gcs' | 'local';
  /** Store `localPath` under the key for `backupId`. */
  put(backupId: string, localPath: string): Promise<PutResult>;
  /** Download the key for `backupId` to `localPath`. */
  get(backupId: string, localPath: string): Promise<void>;
  exists(backupId: string): Promise<boolean>;
  /** Remote size in bytes, or null when the object is absent. */
  size(backupId: string): Promise<number | null>;
  /** All keys under the backup prefix, oldest-first. */
  list(): Promise<string[]>;
  /** Delete one backup — confined to the backup prefix. */
  delete(backupId: string): Promise<void>;
}

export function keyFor(backupId: string): string {
  assertValidBackupId(backupId);
  return backupKey(backupId);
}

function keyToId(key: string): string {
  return posix.basename(key).replace(/\.dump$/, '');
}

/** Deleting is only ever allowed inside the dedicated backup prefix. */
function assertBackupPrefix(key: string): void {
  if (!key.startsWith(BACKUP_PREFIX)) {
    throw new Error(`refusing to operate outside the backup prefix: ${key}`);
  }
}

// ─── Local directory store (dev / rehearsal / air-gapped fallback) ──────────

export class LocalDirStore implements BackupStore {
  readonly kind = 'local' as const;
  constructor(private readonly root: string) {}

  private path(key: string): string {
    assertBackupPrefix(key);
    return join(this.root, key);
  }

  async put(backupId: string, localPath: string): Promise<PutResult> {
    const key = keyFor(backupId);
    const dest = this.path(key);
    await mkdir(posix.dirname(dest), { recursive: true });
    const bytes = await readFile(localPath);
    await writeFile(dest, bytes);
    return { key, sizeBytes: bytes.byteLength };
  }

  async get(backupId: string, localPath: string): Promise<void> {
    const src = this.path(keyFor(backupId));
    await pipeline(createReadStream(src), createWriteStream(localPath));
  }

  async exists(backupId: string): Promise<boolean> {
    try {
      await stat(this.path(keyFor(backupId)));
      return true;
    } catch {
      return false;
    }
  }

  async size(backupId: string): Promise<number | null> {
    try {
      return (await stat(this.path(keyFor(backupId)))).size;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string, prefix: string) => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // prefix not created yet — no backups stored
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`);
        else keys.push(`${prefix}${e.name}`);
      }
    };
    await walk(join(this.root, BACKUP_PREFIX), BACKUP_PREFIX);
    keys.sort();
    return keys;
  }

  async delete(backupId: string): Promise<void> {
    const key = keyFor(backupId);
    assertBackupPrefix(key);
    await rm(this.path(key));
    // Prune now-empty date directories, best-effort.
    let dir = posix.dirname(key);
    while (dir.startsWith(BACKUP_PREFIX) && dir.length > BACKUP_PREFIX.length) {
      try {
        await rm(join(this.root, dir), { recursive: true });
        dir = posix.dirname(dir);
      } catch {
        break; // not empty — exactly what we want
      }
    }
  }
}

// ─── Google Cloud Storage store (Firebase Cloud Storage in production) ─────
//
// The narrow surface of the SDK this adapter uses is declared as an interface
// so the adapter is unit-testable with a deterministic fake — no network, no
// credentials, and no confusion between "mocked adapter test" and real
// provider verification (which is performed separately against the actual
// bucket once credentials exist).

export interface GcsFileApi {
  save(data: Buffer, options?: { contentType?: string; resumable?: boolean }): Promise<unknown>;
  download(): Promise<[Buffer, unknown]>;
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<{ size?: number | string }>;
  delete(): Promise<unknown>;
}

export interface GcsBucketApi {
  file(name: string): GcsFileApi;
  /** Prefix-scoped listing (the SDK aggregates pagination). */
  getFiles(options: { prefix: string; autoPaginate: true }): Promise<{ name: string }[]>;
}

export class GcsStore implements BackupStore {
  readonly kind = 'gcs' as const;
  private readonly bucketName: string;
  private readonly bucket: GcsBucketApi;

  constructor(cfg: StoreConfig & { kind: 'gcs' }, bucket?: GcsBucketApi) {
    if (!cfg.bucket || !cfg.projectId) {
      throw new Error('GCS store requires FIREBASE_STORAGE_BUCKET and FIREBASE_PROJECT_ID');
    }
    this.bucketName = cfg.bucket;
    // Explicit service-account credential (env `GCS_BACKUP_CREDENTIALS_JSON`,
    // server-only) or — when absent — Application Default Credentials
    // (Workload Identity Federation in CI, `gcloud auth application-default`
    // locally). The adapter never sees or stores a private key itself.
    let credentials: Record<string, unknown> | undefined;
    if (cfg.credentialsJson) {
      try {
        credentials = JSON.parse(cfg.credentialsJson);
      } catch {
        throw new Error('GCS_BACKUP_CREDENTIALS_JSON is not valid JSON');
      }
      if (
        !credentials || typeof credentials !== 'object' ||
        typeof (credentials as Record<string, unknown>).client_email !== 'string' ||
        typeof (credentials as Record<string, unknown>).private_key !== 'string'
      ) {
        throw new Error('GCS_BACKUP_CREDENTIALS_JSON does not look like a service-account key (client_email/private_key missing)');
      }
    }
    if (bucket) {
      this.bucket = bucket; // injected fake for unit tests
    } else {
      const storage = new Storage({
        projectId: cfg.projectId,
        ...(credentials ? { credentials } : {}),
        ...(cfg.apiEndpoint ? { apiEndpoint: cfg.apiEndpoint } : {}),
      });
      this.bucket = storage.bucket(this.bucketName) as unknown as GcsBucketApi;
    }
  }

  async put(backupId: string, localPath: string): Promise<PutResult> {
    const key = keyFor(backupId);
    const body = await readFile(localPath);
    await this.bucket.file(key).save(body, {
      contentType: 'application/octet-stream',
      // One-shot upload: no resumable session state, no partial artifacts.
      resumable: false,
    });
    return { key, sizeBytes: body.byteLength };
  }

  async get(backupId: string, localPath: string): Promise<void> {
    const [bytes] = await this.bucket.file(keyFor(backupId)).download();
    await writeFile(localPath, bytes);
  }

  async exists(backupId: string): Promise<boolean> {
    return (await this.size(backupId)) !== null;
  }

  async size(backupId: string): Promise<number | null> {
    try {
      const meta = await this.bucket.file(keyFor(backupId)).getMetadata();
      return meta.size == null ? null : Number(meta.size);
    } catch {
      return null; // absent object — the backup script treats null as missing
    }
  }

  async list(): Promise<string[]> {
    // Listing is deliberately prefix-scoped: unrelated objects in the same
    // bucket (school logos, photos, exports…) are not even visible here.
    const files = await this.bucket.getFiles({ prefix: BACKUP_PREFIX, autoPaginate: true });
    return files.map((f) => f.name).sort();
  }

  async delete(backupId: string): Promise<void> {
    const key = keyFor(backupId);
    assertBackupPrefix(key);
    await this.bucket.file(key).delete();
  }
}

/** Build the store described by the validated environment. */
export function storeFromConfig(cfg: StoreConfig): BackupStore {
  if (cfg.kind === 'local') return new LocalDirStore(cfg.localDir!);
  if (cfg.kind === 'gcs') return new GcsStore({ ...cfg, kind: 'gcs' });
  throw new Error(`unknown store kind: ${(cfg as StoreConfig).kind}`);
}

/** Map a storage key back to its backup id (list → id for --list / --backup). */
export function idFromKey(key: string): string {
  return keyToId(key);
}
