/**
 * The restore job body, kept free of Inngest so it can be tested directly (the Inngest function in
 * src/inngest/functions.ts is thin glue around this).
 *
 * Always: marks the job restoring, runs the all-or-nothing restore with the principal password
 * DEFERRED (a password must never be parked in a job row), records the outcome in plain English, and
 * deletes the uploaded pieces whatever happened, since they hold a whole school's data.
 */
import { eq } from 'drizzle-orm';
import { asPlatformAdmin, schema } from '@/db';
import { BackupFormatError } from './format';
import { RestoreIntegrityError } from './remap';
import { prepareUploadedFile, PluginFileError } from './prepare-upload';
import { restoreSchool } from './restore';
import { discardChunks, markJob, readUploadedFile } from './upload';

export type RestoreJobOutcome = { ok: true; schoolId: number } | { ok: false; message: string };

/** Turn any failure into a sentence an operator can act on. Internal detail stays in the server log. */
export function friendlyRestoreError(err: unknown): string {
  if (err instanceof BackupFormatError || err instanceof RestoreIntegrityError || err instanceof PluginFileError) return err.message;
  const text = err instanceof Error ? `${err.message} ${(err as { code?: string }).code ?? ''}` : String(err);
  if (/schools_code|23505.*code|duplicate key.*code/i.test(text)) return 'A school with that code already exists. Choose a different code and upload again.';
  if (/subdomain/i.test(text)) return 'That subdomain is already in use. Choose a different one and upload again.';
  if (/23505|duplicate key/i.test(text)) return 'The backup conflicts with data that already exists on the platform. Nothing was restored.';
  return 'The restore could not be completed and was rolled back. Nothing was restored. Try again, and contact support if it keeps happening.';
}

export async function runRestoreJob(jobId: number, actorUserId: number): Promise<RestoreJobOutcome> {
  const job = await asPlatformAdmin(actorUserId, `Read restore job ${jobId}`, async (tx) =>
    (await tx.select().from(schema.schoolBackupJobs).where(eq(schema.schoolBackupJobs.id, jobId)))[0]);
  if (!job) return { ok: false, message: 'That restore job does not exist.' };
  // Idempotent: a retried or duplicate event must not restore the same upload twice.
  if (job.status !== 'queued') return { ok: false, message: `This job is ${job.status} and was not started again.` };

  await markJob(actorUserId, jobId, { status: 'restoring' });
  try {
    const uploaded = await readUploadedFile(jobId, actorUserId);
    // A file from the WordPress plugin is read, checked and translated first; a SaaS file passes straight through.
    const { file, source, report } = prepareUploadedFile(uploaded);
    const result = await restoreSchool({
      actorUserId, file, code: job.newSchoolCode, subdomain: job.newSchoolSubdomain ?? null,
      name: job.newSchoolName ?? undefined, principalPassword: 'defer',
    });
    await markJob(actorUserId, jobId, { status: 'succeeded', restoredSchoolId: result.school.id, summary: source === 'plugin' ? { ...result.counts, _fromPlugin: 1, _notes: report?.notes.length ?? 0 } : result.counts });
    return { ok: true, schoolId: result.school.id };
  } catch (err) {
    console.error(JSON.stringify({ job: 'restore-school', jobId, status: 'failed', error: err instanceof Error ? err.message : String(err) }));
    const message = friendlyRestoreError(err);
    await markJob(actorUserId, jobId, { status: 'failed', errorMessage: message });
    return { ok: false, message };
  } finally {
    await discardChunks(actorUserId, jobId).catch(() => {});
  }
}
