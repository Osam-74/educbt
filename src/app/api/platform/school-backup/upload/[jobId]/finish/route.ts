import { NextResponse } from 'next/server';
import { gatePlatformAdmin } from '@/lib/school-backup/guard';
import { completeUpload, UploadError } from '@/lib/school-backup/upload';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** All pieces sent: verify them, then hand the restore to the background job. */
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await gatePlatformAdmin(req, { mutates: true });
  if (!gate.ok) return gate.response;

  const id = Number((await params).jobId);
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, message: 'Bad address.' }, { status: 400 });

  try {
    await completeUpload(gate.actor.userId, id);
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ ok: false, message: e.message }, { status: 422 });
    console.error(JSON.stringify({ route: 'school-backup/upload/finish', jobId: id, error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, message: 'The upload could not be finished.' }, { status: 500 });
  }

  // Only the id and the actor travel in the event: never any school data and never a password.
  try {
    await inngest.send({ name: 'school-backup/restore.requested', data: { jobId: id, actorUserId: gate.actor.userId } });
  } catch (e) {
    console.error(JSON.stringify({ route: 'school-backup/upload/finish', jobId: id, stage: 'enqueue', error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, message: 'The file was uploaded and verified, but the restore could not be queued. Open the restore page and use "Retry" on this upload.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true, jobId: id }, { headers: { 'Cache-Control': 'no-store' } });
}
