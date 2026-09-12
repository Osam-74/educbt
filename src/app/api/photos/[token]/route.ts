/**
 * Public passport-photo serve route. The upload token is a 32-byte random
 * value, so the token IS the capability — like a signed S3 URL. This is
 * deliberate: the report-card print pipelines (WeasyPrint, headless Chrome)
 * fetch photos over HTTP without session cookies, so requiring one would
 * silently produce report cards with empty photo boxes.
 *
 * Cross-tenant reads are still impossible: a photo can only be created inside
 * a forSchool transaction, and the token space is not enumerable.
 */

import { eq } from 'drizzle-orm';
import { db, schema } from '@/db';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) {
    return new Response('Not found', { status: 404 });
  }

  // No school transaction on purpose: no session, no tenant — the token is
  // the only credential (the public_token_read RLS policy allows this one
  // table's SELECTs). Single row by unique index, read-only.
  const [row] = await db.select({ mimeType: schema.portalUploads.mimeType, data: schema.portalUploads.data })
    .from(schema.portalUploads)
    .where(eq(schema.portalUploads.token, token))
    .limit(1);
  if (!row) return new Response('Not found', { status: 404 });

  const body = new Uint8Array(row.data ?? Buffer.alloc(0));
  return new Response(body, {
    headers: {
      'Content-Type': row.mimeType,
      // The token never changes and is never reused; the photo behind it can.
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
}
