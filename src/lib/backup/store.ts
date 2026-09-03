/**
 * Backup storage — the smallest R2 integration that is still real.
 *
 * Cloudflare R2 is S3-API compatible, so the production store speaks plain
 * S3 (PutObject / HeadObject / ListObjectsV2 / GetObject / DeleteObject)
 * against the R2 endpoint. The SAME implementation runs unchanged against
 * any S3-compatible server — which is how the restore rehearsal exercises
 * the real storage code path locally (MinIO) without real R2 credentials.
 *
 * Security posture:
 *  - The bucket is private; backups never get public URLs. This module has
 *    no presign / public-URL code at all — it cannot leak a download link.
 *  - Credentials are server/infrastructure-only and never appear in logs.
 *  - Deletion is structurally confined to the `backups/database/` prefix
 *    (see assertBackupKey) — a broad bucket delete is impossible to express
 *    through this API.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { assertValidBackupId, backupKey, BACKUP_PREFIX } from './naming';
import type { StoreConfig } from './env';

export interface PutResult {
  key: string;
  sizeBytes: number;
}

export interface BackupStore {
  readonly kind: 'r2' | 'local';
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

// ─── S3-compatible store (Cloudflare R2 in production, MinIO in tests) ─────

export class S3CompatibleStore implements BackupStore {
  readonly kind = 'r2' as const;
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(cfg: StoreConfig & { kind: 'r2' }) {
    if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey || !cfg.endpoint) {
      throw new Error('S3-compatible store requires bucket, accessKeyId, secretAccessKey and endpoint');
    }
    this.bucketName = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region ?? 'auto',
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });
  }

  async put(backupId: string, localPath: string): Promise<PutResult> {
    const key = keyFor(backupId);
    const body = await readFile(localPath);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucketName, Key: key, Body: body, ContentType: 'application/octet-stream' }),
    );
    return { key, sizeBytes: body.byteLength };
  }

  async get(backupId: string, localPath: string): Promise<void> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: keyFor(backupId) }),
    );
    if (!res.Body) throw new Error(`empty body downloading backup ${backupId}`);
    await pipeline(res.Body as unknown as NodeJS.ReadableStream, createWriteStream(localPath));
  }

  async exists(backupId: string): Promise<boolean> {
    return (await this.size(backupId)) !== null;
  }

  async size(backupId: string): Promise<number | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: keyFor(backupId) }),
      );
      return res.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  async list(): Promise<string[]> {
    // Listing is deliberately prefix-scoped: unrelated objects in the same
    // bucket are not even visible here.
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucketName, Prefix: BACKUP_PREFIX, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key) keys.push(obj.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    keys.sort();
    return keys;
  }

  async delete(backupId: string): Promise<void> {
    const key = keyFor(backupId);
    assertBackupPrefix(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
  }
}

/** Build the store described by the validated environment. */
export function storeFromConfig(cfg: StoreConfig): BackupStore {
  if (cfg.kind === 'local') return new LocalDirStore(cfg.localDir!);
  if (cfg.kind === 'r2') return new S3CompatibleStore({ ...cfg, kind: 'r2' });
  throw new Error(`unknown store kind: ${(cfg as StoreConfig).kind}`);
}

/** Map a storage key back to its backup id (list → id for --list / --backup). */
export function idFromKey(key: string): string {
  return keyToId(key);
}
