/**
 * Platform branding — the platform's OWN logo (correction-pass item 6).
 *
 * The logo rendered in the admin shell header. Stored as a DB-backed base64
 * PNG exactly like a school crest (settings/images.ts normalizeImage): the
 * same pipeline, the same 2 MB / 400 KB limits, so rendering never depends
 * on an expiring object-storage URL.
 *
 * SECURITY MODEL:
 *   - Reads are open by RLS (branding_public_read — a logo is public
 *     presentation data), so the shell can render on every page request
 *     without the per-request audited elevation asPlatformAdmin() demands.
 *   - Writes go through the platform_admin elevation exactly once, inside
 *     savePlatformBranding — with an audit row recording the change. No
 *     school user can ever reach the page (requirePlatformSession), and the
 *     service re-checks the role before touching the database.
 *   - The singleton row (id = 1, CHECK-enforced) is upserted, never
 *     created ad hoc — no orphan rows, no "which row is live" ambiguity.
 */

import { eq, sql } from 'drizzle-orm';
import { db, schema } from '@/db';
import { normalizeImage } from '@/lib/settings/images';
import type { PlatformActor } from '@/lib/platform/session';

export class BrandingError extends Error {}

/** The platform logo shown in the shell, or null when none is set. */
export async function viewPlatformBranding(): Promise<{ logoUrl: string | null }> {
  const [row] = await db
    .select({ logoUrl: schema.platformSettings.logoUrl })
    .from(schema.platformSettings)
    .where(eq(schema.platformSettings.id, 1))
    .limit(1);
  return { logoUrl: row?.logoUrl ?? null };
}

/**
 * Set, change or remove the platform logo. `logo` is an upload the caller
 * (a server action) received as a File; `remove` clears it instead.
 * Every change is audited with the old value.
 */
export async function savePlatformBranding(
  actor: PlatformActor,
  input: { logo?: File | null; remove?: boolean },
): Promise<void> {
  if (actor.role !== 'platform_admin') {
    throw new BrandingError('Only platform administrators may change platform branding.');
  }
  if (!input.logo && !input.remove) {
    throw new BrandingError('Choose a logo image to upload, or press Remove.');
  }

  let normalized: string | null = null;
  if (input.logo && input.logo.size > 0) {
    try {
      normalized = await normalizeImage(input.logo);
    } catch (error) {
      // normalizeImage speaks SettingsError; surface the same human message
      // under this service's error type.
      throw new BrandingError(error instanceof Error ? error.message : 'That image could not be read.');
    }
  } else if (!input.remove) {
    throw new BrandingError('Choose a PNG, JPEG or WebP smaller than 2 MB.');
  }

  await db.transaction(async (tx) => {
    // The write policy (branding_platform_admin_write) and the audit row
    // (school_id NULL) both require the elevation for THIS transaction.
    await tx.execute(sql`select set_config('app.platform_admin', 'on', true)`);

    const [before] = await tx
      .select({ logoUrl: schema.platformSettings.logoUrl })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.id, 1))
      .limit(1);

    const next = input.remove ? null : (normalized ?? before?.logoUrl ?? null);

    await tx
      .insert(schema.platformSettings)
      .values({ id: 1, logoUrl: next })
      .onConflictDoUpdate({
        target: schema.platformSettings.id,
        set: { logoUrl: next, updatedAt: new Date() },
      });

    await tx.insert(schema.auditLog).values({
      schoolId: null,
      actorUserId: actor.userId,
      actorRole: 'platform_admin',
      action: 'platform.branding_changed',
      entityType: 'platform_settings',
      entityId: 1,
      before: { logoUrl: before?.logoUrl ?? null },
      after: { logoUrl: next },
    });
  });
}
