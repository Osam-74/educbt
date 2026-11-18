'use server';

/** Glue only: session guard, then the service decides. Same pattern as the other platform actions. */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { cancelJob, failStaleRestore, UploadError } from '@/lib/school-backup/upload';
import { inngest } from '@/inngest/client';

function back(qs: Record<string, string>): never {
  redirect(`/platform/schools/restore?${new URLSearchParams(qs).toString()}`);
}

export async function cancelRestoreAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformSession();
  try { await cancelJob(actor.userId, Number(formData.get('jobId'))); }
  catch (e) { back({ error: e instanceof UploadError ? e.message : 'That upload could not be cancelled.' }); }
  revalidatePath('/platform/schools/restore');
  back({ ok: 'Upload cancelled and its data deleted.' });
}

/** A verified upload whose background job never started (the queue was down): send the event again. */
export async function retryRestoreAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformSession();
  const jobId = Number(formData.get('jobId'));
  try { await inngest.send({ name: 'school-backup/restore.requested', data: { jobId, actorUserId: actor.userId } }); }
  catch { back({ error: 'The restore could not be queued yet. Try again in a minute.' }); }
  revalidatePath('/platform/schools/restore');
  back({ ok: 'Restore queued again.' });
}

export async function failStaleRestoreAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformSession();
  try { await failStaleRestore(actor.userId, Number(formData.get('jobId'))); }
  catch (e) { back({ error: e instanceof UploadError ? e.message : 'That restore could not be reset.' }); }
  revalidatePath('/platform/schools/restore');
  back({ ok: 'The stalled restore was marked as failed. Nothing had been restored. You can upload the file again.' });
}
