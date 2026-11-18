/**
 * Access gate for the school-backup HTTP routes.
 *
 * Route handlers are NOT covered by the /platform page guard, so each one authenticates itself.
 * They answer with a clean 401/403 JSON error (never a redirect page a fetch() would mis-read).
 *
 * Two independent checks, because these routes accept a whole-school upload and serve a whole-school
 * download:
 *   1. a signed-in platform administrator who has finished their forced password change;
 *   2. for anything that changes state, an Origin that matches the host being called. sameSite=lax
 *      cookies already block most cross-site POSTs; this closes the rest explicitly.
 */
import { NextResponse } from 'next/server';
import { currentPlatformActor, type PlatformActor } from '@/lib/platform/session';
import { auth } from '@/lib/auth';

export type Gate = { ok: true; actor: PlatformActor } | { ok: false; response: NextResponse };

/** Pure so it can be unit-tested: is this request's Origin the host it is addressed to? */
export function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try { return new URL(origin).host === host; } catch { return false; }
}

const deny = (status: number, reason: string, message: string): Gate =>
  ({ ok: false, response: NextResponse.json({ ok: false, reason, message }, { status, headers: { 'Cache-Control': 'no-store' } }) });

export async function gatePlatformAdmin(req: Request, opts: { mutates: boolean }): Promise<Gate> {
  const actor = await currentPlatformActor();
  if (!actor) return deny(401, 'not_signed_in', 'Please sign in as a platform administrator.');

  // A fresh or reset account must set its own password before it can administer anything.
  const user = await auth();
  if (!user || user.mustChangePassword) return deny(403, 'password_change_required', 'Change your password before using this.');

  if (opts.mutates && !sameOrigin(req.headers.get('origin'), req.headers.get('host'))) {
    return deny(403, 'bad_origin', 'This request did not come from the platform.');
  }
  return { ok: true, actor };
}
