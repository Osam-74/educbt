/**
 * Chunked upload of a backup file, and the job record that tracks its restore.
 *
 * Vercel rejects request bodies over 4.5 MB, so the browser sends the file in slices of at most
 * MAX_CHUNK_BYTES. Nothing the browser says is trusted: sizes, order and the whole-file checksum are
 * all re-checked here, and decode() verifies the document's own checksum again before any row is written.
 *
 * Every function runs inside asPlatformAdmin(): the tables are platform-admin-only (rls.sql) and each
 * call leaves an audit entry. Nothing here ever holds a password.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { asPlatformAdmin, schema } from '@/db';
import { MAX_COMPRESSED_BYTES } from './format';

export const MAX_CHUNK_BYTES = 3 * 1024 * 1024; // comfortably under Vercel's 4.5 MB limit
export const MAX_CHUNKS = Math.ceil(MAX_COMPRESSED_BYTES / MAX_CHUNK_BYTES) + 1;

export class UploadError extends Error {}

export type JobView = {
  id: number; status: string; fileName: string; totalBytes: number; totalChunks: number; receivedChunks: number;
  newSchoolCode: string; restoredSchoolId: number | null; errorMessage: string | null;
  summary: Record<string, number> | null; createdAt: string; updatedAt: string;
};

const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/;
const SUBDOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const SHA = /^[a-f0-9]{64}$/;

export async function startUpload(actorUserId: number, input: {
  fileName: string; totalBytes: number; totalChunks: number; sha256: string;
  code: string; subdomain?: string | null; name?: string | null;
}): Promise<{ jobId: number }> {
  const fileName = String(input.fileName ?? '').replace(/[^\w.\- ]+/g, '_').slice(0, 200) || 'backup.educbt-school.gz';
  if (!Number.isInteger(input.totalBytes) || input.totalBytes <= 0) throw new UploadError('The file is empty.');
  if (input.totalBytes > MAX_COMPRESSED_BYTES) throw new UploadError('The file is larger than the supported maximum.');
  if (!Number.isInteger(input.totalChunks) || input.totalChunks < 1 || input.totalChunks > MAX_CHUNKS
    || input.totalChunks < Math.ceil(input.totalBytes / MAX_CHUNK_BYTES)) throw new UploadError('The upload plan is not valid.');
  if (!SHA.test(String(input.sha256 ?? ''))) throw new UploadError('The file checksum is missing or malformed.');
  if (!CODE.test(String(input.code ?? ''))) throw new UploadError('Enter a school code of letters, numbers, hyphens or underscores.');
  const subdomain = input.subdomain ? String(input.subdomain).toLowerCase() : null;
  if (subdomain && !SUBDOMAIN.test(subdomain)) throw new UploadError('The subdomain may use only lowercase letters, numbers and hyphens.');

  return asPlatformAdmin(actorUserId, `Begin restore upload of ${fileName}`, async (tx) => {
    // Refuse early when the identity is taken, so the operator is not told only after a long upload.
    const taken = await tx.execute(sql`select 1 from schools where lower(code) = lower(${input.code}) ${subdomain ? sql`or subdomain = ${subdomain}` : sql``} limit 1`);
    if ((taken as unknown as unknown[]).length) throw new UploadError('A school with that code or subdomain already exists.');
    const [job] = await tx.insert(schema.schoolBackupJobs).values({
      createdBy: actorUserId, fileName, totalBytes: input.totalBytes, totalChunks: input.totalChunks, sha256: input.sha256,
      newSchoolCode: input.code, newSchoolSubdomain: subdomain, newSchoolName: input.name?.trim() || null,
    }).returning({ id: schema.schoolBackupJobs.id });
    return { jobId: Number(job!.id) };
  });
}

export async function addChunk(actorUserId: number, jobId: number, position: number, data: Buffer): Promise<{ received: number }> {
  if (!Number.isInteger(position) || position < 0) throw new UploadError('Invalid chunk position.');
  if (data.length === 0) throw new UploadError('Empty chunk.');
  if (data.length > MAX_CHUNK_BYTES) throw new UploadError('That piece is larger than allowed.');
  return asPlatformAdmin(actorUserId, `Upload restore chunk ${position} of job ${jobId}`, async (tx) => {
    const [job] = await tx.select().from(schema.schoolBackupJobs).where(eq(schema.schoolBackupJobs.id, jobId));
    if (!job) throw new UploadError('That upload does not exist.');
    if (job.status !== 'uploading') throw new UploadError('This upload is no longer accepting pieces.');
    if (position >= job.totalChunks) throw new UploadError('That piece is outside the declared upload.');
    // Re-sending a piece (a retry after a network drop) replaces it; it never duplicates.
    await tx.insert(schema.schoolBackupChunks).values({ jobId, position, data, byteSize: data.length })
      .onConflictDoUpdate({ target: [schema.schoolBackupChunks.jobId, schema.schoolBackupChunks.position], set: { data, byteSize: data.length } });
    const counted = (await tx.execute(sql`select count(*)::int as n from school_backup_chunks where job_id = ${jobId}`)) as unknown as Array<{ n: number }>;
    return { received: counted[0]?.n ?? 0 };
  });
}

/**
 * Close the upload: every piece present, total size and checksum match what the browser declared.
 * Only then is the job queued. On any mismatch the pieces are deleted and the job fails, so a
 * damaged upload cannot linger or be restored by accident.
 */
export async function completeUpload(actorUserId: number, jobId: number): Promise<{ queued: true }> {
  // The transaction RETURNS a problem instead of throwing it: a throw would roll back the very
  // bookkeeping (job marked failed, pieces deleted) that a failed upload needs to keep.
  const outcome = await asPlatformAdmin(actorUserId, `Finish restore upload job ${jobId}`, async (tx): Promise<{ problem: string } | { queued: true }> => {
    const [job] = await tx.select().from(schema.schoolBackupJobs).where(eq(schema.schoolBackupJobs.id, jobId));
    if (!job) return { problem: 'That upload does not exist.' };
    if (job.status !== 'uploading') return { problem: 'This upload was already finished.' };

    const fail = async (message: string): Promise<{ problem: string }> => {
      await tx.delete(schema.schoolBackupChunks).where(eq(schema.schoolBackupChunks.jobId, jobId));
      await tx.update(schema.schoolBackupJobs).set({ status: 'failed', errorMessage: message, updatedAt: new Date() }).where(eq(schema.schoolBackupJobs.id, jobId));
      return { problem: message };
    };

    const rows = await tx.select({ position: schema.schoolBackupChunks.position, data: schema.schoolBackupChunks.data })
      .from(schema.schoolBackupChunks).where(eq(schema.schoolBackupChunks.jobId, jobId)).orderBy(asc(schema.schoolBackupChunks.position));
    if (rows.length !== job.totalChunks) return fail(`Only ${rows.length} of ${job.totalChunks} pieces arrived. Please upload the file again.`);
    for (let i = 0; i < rows.length; i++) if (rows[i]!.position !== i) return fail('A piece is missing from the upload. Please upload the file again.');

    const hash = createHash('sha256'); let bytes = 0;
    for (const r of rows) { hash.update(r.data); bytes += r.data.length; }
    if (bytes !== Number(job.totalBytes)) return fail('The uploaded size does not match the file. Please upload it again.');
    if (hash.digest('hex') !== job.sha256) return fail('The uploaded file does not match its checksum, so it was damaged in transit. Please upload it again.');

    await tx.update(schema.schoolBackupJobs).set({ status: 'queued', updatedAt: new Date() }).where(eq(schema.schoolBackupJobs.id, jobId));
    return { queued: true };
  });
  if ('problem' in outcome) throw new UploadError(outcome.problem);
  return { queued: true };
}

/** Reassemble the uploaded file for the restore worker. */
export async function readUploadedFile(jobId: number, actorUserId: number): Promise<Buffer> {
  return asPlatformAdmin(actorUserId, `Read restore upload job ${jobId}`, async (tx) => {
    const rows = await tx.select({ data: schema.schoolBackupChunks.data }).from(schema.schoolBackupChunks)
      .where(eq(schema.schoolBackupChunks.jobId, jobId)).orderBy(asc(schema.schoolBackupChunks.position));
    return Buffer.concat(rows.map((r) => r.data));
  });
}

export async function discardChunks(actorUserId: number, jobId: number): Promise<void> {
  await asPlatformAdmin(actorUserId, `Discard restore upload pieces for job ${jobId}`, async (tx) => {
    await tx.delete(schema.schoolBackupChunks).where(eq(schema.schoolBackupChunks.jobId, jobId));
  });
}

export async function cancelJob(actorUserId: number, jobId: number): Promise<void> {
  await asPlatformAdmin(actorUserId, `Cancel restore job ${jobId}`, async (tx) => {
    const [job] = await tx.select().from(schema.schoolBackupJobs).where(eq(schema.schoolBackupJobs.id, jobId));
    if (!job) throw new UploadError('That upload does not exist.');
    if (!['uploading', 'queued'].includes(job.status)) throw new UploadError('Only an upload that has not started restoring can be cancelled.');
    await tx.delete(schema.schoolBackupChunks).where(eq(schema.schoolBackupChunks.jobId, jobId));
    await tx.update(schema.schoolBackupJobs).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(schema.schoolBackupJobs.id, jobId)));
  });
}

/** A restore that has shown no sign of life for this long is treated as dead (a server restart mid-run). */
export const STALE_RESTORE_MINUTES = 30;

export async function getJob(actorUserId: number, jobId: number): Promise<JobView | null> {
  return (await listJobs(actorUserId, 50)).find((j) => j.id === jobId) ?? null;
}

/**
 * Mark a restore that never finished as failed so the operator can start again.
 *
 * Safe because the restore is ONE transaction: it either committed completely (the job would say
 * 'succeeded') or rolled back completely, so a job still 'restoring' after STALE_RESTORE_MINUTES
 * produced nothing. A restore that is genuinely still running is refused.
 */
export async function failStaleRestore(actorUserId: number, jobId: number): Promise<void> {
  const changed = await asPlatformAdmin(actorUserId, `Fail stale restore job ${jobId}`, async (tx) => {
    const rows = (await tx.execute(sql`
      update school_backup_jobs
         set status = 'failed', updated_at = now(),
             error_message = 'The restore stopped before it finished (the server was restarted). Nothing was restored. Upload the file again.'
       where id = ${jobId} and status = 'restoring' and updated_at < now() - make_interval(mins => ${STALE_RESTORE_MINUTES})
       returning id`)) as unknown as Array<{ id: number }>;
    if (rows.length) await tx.delete(schema.schoolBackupChunks).where(eq(schema.schoolBackupChunks.jobId, jobId));
    return rows.length;
  });
  if (!changed) throw new UploadError(`That restore is either not running or is still within its ${STALE_RESTORE_MINUTES} minute allowance.`);
}

export async function listJobs(actorUserId: number, limit = 20): Promise<JobView[]> {
  return asPlatformAdmin(actorUserId, 'List school restore jobs', async (tx) => {
    const rows = (await tx.execute(sql`
      select j.*, (select count(*)::int from school_backup_chunks c where c.job_id = j.id) as received
      from school_backup_jobs j order by j.created_at desc limit ${limit}`)) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id), status: String(r.status), fileName: String(r.file_name), totalBytes: Number(r.total_bytes),
      totalChunks: Number(r.total_chunks), receivedChunks: Number(r.received), newSchoolCode: String(r.new_school_code),
      restoredSchoolId: r.restored_school_id == null ? null : Number(r.restored_school_id),
      errorMessage: (r.error_message as string | null) ?? null, summary: (r.summary as Record<string, number> | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(),
    }));
  });
}

export async function markJob(actorUserId: number, jobId: number, patch: {
  status: 'restoring' | 'succeeded' | 'failed'; errorMessage?: string | null; restoredSchoolId?: number; summary?: Record<string, number>;
}): Promise<void> {
  await asPlatformAdmin(actorUserId, `Update restore job ${jobId} to ${patch.status}`, async (tx) => {
    await tx.update(schema.schoolBackupJobs).set({
      status: patch.status, errorMessage: patch.errorMessage ?? null, restoredSchoolId: patch.restoredSchoolId ?? null,
      summary: patch.summary ?? null, updatedAt: new Date(),
    }).where(eq(schema.schoolBackupJobs.id, jobId));
  });
}
