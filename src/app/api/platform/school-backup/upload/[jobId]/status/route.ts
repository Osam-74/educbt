import { NextResponse } from 'next/server';
import { gatePlatformAdmin } from '@/lib/school-backup/guard';
import { getJob } from '@/lib/school-backup/upload';

export const dynamic = 'force-dynamic';

/** Progress for one upload/restore. Read-only; never returns file data or any password. */
export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await gatePlatformAdmin(req, { mutates: false });
  if (!gate.ok) return gate.response;
  const id = Number((await params).jobId);
  if (!Number.isInteger(id)) return NextResponse.json({ ok: false, message: 'Bad address.' }, { status: 400 });
  const job = await getJob(gate.actor.userId, id);
  if (!job) return NextResponse.json({ ok: false, message: 'That upload does not exist.' }, { status: 404 });
  return NextResponse.json({ ok: true, job }, { headers: { 'Cache-Control': 'no-store' } });
}
