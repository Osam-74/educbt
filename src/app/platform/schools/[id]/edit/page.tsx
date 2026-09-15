import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { schoolDetail, NotFoundError } from '@/lib/platform/schools';
import { EditSchoolForm } from './EditSchoolForm';

export const dynamic = 'force-dynamic';

export default async function EditSchoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await requirePlatformSession();
  const schoolId = Number(id);

  let school;
  try {
    school = await schoolDetail(actor, schoolId, `Open school #${schoolId} for editing`);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const platformDomain = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase() || null;
  const host = (await headers()).get('host');
  const hint = platformDomain || (host?.split(':')[0] ?? null);

  return (
    <div id="edit-school-view" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Edit {school.name}</h1>
          <p>Update the school&apos;s profile, contact details and crest. Code, status and the principal are managed elsewhere.</p>
        </div>
      </div>
      <EditSchoolForm
        school={{
          id: school.id,
          name: school.name,
          code: school.code,
          email: school.email,
          phone: school.phone,
          address: school.address,
          subdomain: school.subdomain,
          logoUrl: school.logoUrl,
        }}
        loginUrlHint={hint}
      />
    </div>
  );
}
