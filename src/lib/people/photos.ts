/**
 * Passport photographs: upload, store and serve.
 *
 * Stored in the tenant database (portal_uploads) rather than a media library
 * — the app is self-contained, and bytea keeps photos inside the same tenant
 * isolation, RLS and backup stream as every other school record.
 *
 * Served publicly by unguessable token (/api/photos/{token}): the token IS the
 * capability, like a signed S3 URL. Report-card print pipelines (WeasyPrint,
 * headless Chrome) cannot carry session cookies, so the photo must be
 * fetchable without one; a 32-byte random token is not enumerable.
 */

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema, forSchool } from '@/db';
import type { Actor } from '@/lib/session';

export class PhotoError extends Error {}

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** A passport photograph needs to be legible, not archival. The legacy
 *  wp_handle_upload accepted anything; a 40MB phone panorama is a DoS on the
 *  database row, and school scanners produce well under this. */
export const MAX_PHOTO_BYTES = 1024 * 1024;

export function photoUrlFor(token: string): string {
  return `/api/photos/${token}`;
}

/**
 * Validate and store an uploaded photograph from a form's file input.
 * Returns the public URL, or null when the field was left empty (an absent
 * photo is fine — existing photos are only replaced, never cleared).
 */
export async function savePassportPhoto(actor: Actor, file: unknown): Promise<string | null> {
  if (!(file instanceof File) || file.size === 0) return null;

  if (!ALLOWED_MIME.has(file.type)) {
    throw new PhotoError('The passport photograph must be a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new PhotoError('The passport photograph must be under 1 MB.');
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const token = randomBytes(32).toString('base64url');

  await forSchool(actor.schoolId, async (tx) => {
    await tx.insert(schema.portalUploads).values({
      schoolId: actor.schoolId,
      token,
      mimeType: file.type,
      byteSize: bytes.byteLength,
      data: bytes,
    });
  });

  return photoUrlFor(token);
}
