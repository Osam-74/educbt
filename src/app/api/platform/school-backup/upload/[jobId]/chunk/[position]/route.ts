import { NextResponse } from 'next/server';
import { gatePlatformAdmin } from '@/lib/school-backup/guard';
import { addChunk, MAX_CHUNK_BYTES, UploadError } from '@/lib/school-backup/upload';

export const dynamic = 'force-dynamic';
// A piece is at most ~3 MB; the platform allows a little longer than the default for slow links.
export const maxDuration = 60;

/** One piece of the file, sent as the raw request body (no multipart, no base64 overhead). */
export async function PUT(req: Request, { params }: { params: Promise<{ jobId: string; position: string }> }) {
  const gate = await gatePlatformAdmin(req, { mutates: true });
  if (!gate.ok) return gate.response;

  const { jobId, position } = await params;
  const id = Number(jobId); const pos = Number(position);
  if (!Number.isInteger(id) || !Number.isInteger(pos)) return NextResponse.json({ ok: false, message: 'Bad address.' }, { status: 400 });

  // Refuse early on the declared length so an oversized body is never read into memory.
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > MAX_CHUNK_BYTES) return NextResponse.json({ ok: false, message: 'That piece is larger than allowed.' }, { status: 413 });

  try {
    const data = Buffer.from(await req.arrayBuffer());
    const { received } = await addChunk(gate.actor.userId, id, pos, data);
    return NextResponse.json({ ok: true, received }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ ok: false, message: e.message }, { status: 422 });
    console.error(JSON.stringify({ route: 'school-backup/upload/chunk', jobId: id, error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, message: 'That piece could not be saved. Try again.' }, { status: 500 });
  }
}
