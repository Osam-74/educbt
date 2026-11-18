import { NextResponse } from 'next/server';
import { gatePlatformAdmin } from '@/lib/school-backup/guard';
import { startUpload, UploadError } from '@/lib/school-backup/upload';

export const dynamic = 'force-dynamic';

/** Declare an upload: file name, size, piece count, checksum, and the NEW school's code. */
export async function POST(req: Request) {
  const gate = await gatePlatformAdmin(req, { mutates: true });
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ ok: false, message: 'The request was not understood.' }, { status: 400 });

  try {
    const { jobId } = await startUpload(gate.actor.userId, {
      fileName: String(body.fileName ?? ''),
      totalBytes: Number(body.totalBytes),
      totalChunks: Number(body.totalChunks),
      sha256: String(body.sha256 ?? ''),
      code: String(body.code ?? ''),
      subdomain: body.subdomain ? String(body.subdomain) : null,
      name: body.name ? String(body.name) : undefined,
    });
    return NextResponse.json({ ok: true, jobId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof UploadError) return NextResponse.json({ ok: false, message: e.message }, { status: 422 });
    console.error(JSON.stringify({ route: 'school-backup/upload/start', error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, message: 'The upload could not be started.' }, { status: 500 });
  }
}
