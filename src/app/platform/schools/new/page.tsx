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
    <div id="create-school-view" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Create a school</h1>
          <p>
            Creating a school also creates its first principal — one operation, no
            half-created schools. The principal&apos;s temporary password is shown
            once, at the end.
          </p>
        </div>
      </div>
      <NewSchoolForm loginUrlHint={hint} />
    </div>
  );
}
