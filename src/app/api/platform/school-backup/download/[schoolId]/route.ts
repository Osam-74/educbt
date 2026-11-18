import { NextResponse } from 'next/server';
import { gatePlatformAdmin } from '@/lib/school-backup/guard';
import { exportSchoolAudited } from '@/lib/school-backup/export';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Download a complete backup of one school.
 *
 * POST, not GET: taking a backup writes an audit entry, and a link a browser or a proxy might prefetch
 * must never do that. The body is streamed in slices so the response is not limited to 4.5 MB.
 * `?passwords=1` includes each user's Argon2id password hash (the file is then a sensitive credential
 * store; its name says so).
 */
export async function POST(req: Request, { params }: { params: Promise<{ schoolId: string }> }) {
  const gate = await gatePlatformAdmin(req, { mutates: true });
  if (!gate.ok) return gate.response;

  const id = Number((await params).schoolId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ ok: false, message: 'Bad address.' }, { status: 400 });
  const includePasswords = new URL(req.url).searchParams.get('passwords') === '1';

  try {
    const out = await exportSchoolAudited(gate.actor.userId, id, { includePasswords });
    const SLICE = 1024 * 1024;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= out.file.length) { controller.close(); return; }
        controller.enqueue(new Uint8Array(out.file.subarray(offset, offset + SLICE)));
        offset += SLICE;
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': String(out.file.length),
        'Content-Disposition': `attachment; filename="${out.fileName}"`,
        'Cache-Control': 'no-store',
        'X-Backup-Credentials': out.credentials,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (e) {
    if (e instanceof Error && /does not exist/.test(e.message)) return NextResponse.json({ ok: false, message: 'That school does not exist.' }, { status: 404 });
    console.error(JSON.stringify({ route: 'school-backup/download', schoolId: id, error: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ok: false, message: 'The backup could not be created.' }, { status: 500 });
  }
}
