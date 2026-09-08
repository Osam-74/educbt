import { headers } from 'next/headers';
import { requirePlatformSession } from '@/lib/platform/session';
import { NewSchoolForm } from './NewSchoolForm';

export const dynamic = 'force-dynamic';

export default async function NewSchoolPage() {
  await requirePlatformSession();

  // Shown next to the subdomain field so the platform admin can see what the
  // school's address will look like. PLATFORM_DOMAIN is the future wildcard
  // base; until the owner configures real DNS this is guidance only — the
  // flow itself never touches DNS.
  const platformDomain = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase() || null;
  const host = (await headers()).get('host');
  const hint = platformDomain || (host?.split(':')[0] ?? null);

  return (
    <>
      <h1 className="page-title">Create a school</h1>
      <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 13 }}>
        Creating a school also creates its first principal — one operation, no
        half-created schools. The principal&apos;s temporary password is shown
        once, at the end.
      </p>
      <NewSchoolForm loginUrlHint={hint} />
    </>
  );
}
