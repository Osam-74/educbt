import { headers } from 'next/headers';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tenantFromHost } from '@/lib/tenant';

/**
 * Per-tenant favicon. This app serves many schools on many subdomains from
 * one deployment, so a single static `icon.png` would put every school's
 * browser tab behind the SAME icon — the school crest set in School Settings
 * (Settings > Branding, stored as a data: URL, see lib/settings/images.ts)
 * would only ever show on the storefront that happens to match whatever
 * file shipped in the repo. Resolving the tenant by Host header and
 * decoding ITS crest means six schools show six different tab icons.
 *
 * `logoUrl` is already a `data:image/png;base64,...` URI (normalizeImage
 * re-encodes every upload to PNG and inlines it), so no network fetch is
 * needed — just decode the base64 payload and hand back the bytes. A school
 * with no crest yet, or the platform's own admin domain, falls back to the
 * one shared default icon.
 */
export const dynamic = 'force-dynamic';
export const contentType = 'image/png';

async function defaultIcon(): Promise<Response> {
  const bytes = await readFile(join(process.cwd(), 'public', 'favicon-default.png'));
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' } });
}

export default async function Icon() {
  const host = (await headers()).get('host');
  const tenant = host ? await tenantFromHost(host) : null;

  const dataUrl = tenant?.logoUrl;
  const match = dataUrl?.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!match) return defaultIcon();

  try {
    const bytes = Buffer.from(match[2]!, 'base64');
    return new Response(bytes, {
      headers: { 'Content-Type': `image/${match[1]}`, 'Cache-Control': 'public, max-age=3600' },
    });
  } catch {
    return defaultIcon();
  }
}
