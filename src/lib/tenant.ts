/**
 * Tenant resolution.
 *
 * A hostname tells us WHICH school is being addressed. It never tells us the
 * visitor is allowed to see it — authorisation is checked separately on every
 * protected action. Treating the domain as proof of access is how a guessable
 * subdomain becomes a data breach.
 */

import { resolveSchoolByHost } from '@/db';

export type Tenant = { id: number; name: string; status: string };

export async function tenantFromHost(host: string | null): Promise<Tenant | null> {
  if (!host) return null;

  // Strip port and normalise. Host headers are attacker-controlled, so this is
  // a lookup key and nothing more.
  const clean = host.toLowerCase().split(':')[0] ?? '';
  const platform = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase();

  if (!clean || clean === platform || clean === `www.${platform}`) {
    return null; // the platform site itself, not a school
  }

  const school = await resolveSchoolByHost(clean);

  if (!school) return null;

  // An archived or suspended school resolves to nothing. Its data stays in the
  // database; the door is simply closed.
  if (school.status !== 'active') return null;

  return school;
}
