import { NextResponse } from 'next/server';
import { gatePlatformAdmin } from '@/lib/school-backup/guard';
import { getJob } from '@/lib/school-backup/upload';
import { inngest } from '@/inngest/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Send the "restore this upload" signal again for a job that is verified and waiting.
 *
 * Safe to press repeatedly: the job body only ever starts a job that is still 'queued', so a second
 * delivery of the same event restores nothing twice. Anything not waiting is refused.
 */
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await gatePlatformAdmin(req, { mutates: true });
  if (!gate.ok) return gate.response;

  const id = Number((await params).jobId);
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, message: 'Bad address.' }, { status: 400 });

  const job = await getJob(gate.actor.userId, id);
  if (!job) return NextResponse.json({ ok: false, message: 'That upload does not exist.' }, { status: 404 });
  if (job.status !== 'queued') return NextResponse.json({ ok: false, message: `This restore is ${job.status}, so there is nothing to retry.` }, { status: 409 });

  try {
    await inngest.send({ name: 'school-backup/restore.requested', data: { jobId: id, actorUserId: gate.actor.userId } });
  } catch (e) {
    console.error(JSON.stringify({ route: 'school-backup/upload/retry', jobId: id, error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, message: 'The background service could not be reached. Try again in a minute.' }, { status: 503 });
  }
  return NextResponse.json({ ok: true, jobId: id }, { headers: { 'Cache-Control': 'no-store' } });
}
