import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import { schoolDetail } from '@/lib/platform/schools';
import { reactivateSchoolAction, suspendSchoolAction } from './actions';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pill pill--active',
  suspended: 'pill pill--suspended',
  archived: 'pill pill--withdrawn',
};

function fmt(d: Date) {
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function SchoolDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const flash = await searchParams;
  const actor = await requirePlatformSession();
  const schoolId = Number(id);

  if (!Number.isInteger(schoolId) || schoolId <= 0) notFound();

  const school = await schoolDetail(actor, schoolId).catch(() => null);

  if (!school) {
    return (
      <section className="card">
        <h2>School not found</h2>
        <p className="muted">
          This school does not exist or was removed. Nothing else changed.
        </p>
        <p><Link href="/platform/schools" className="primary-wide">Back to schools</Link></p>
      </section>
    );
  }

  const suspended = school.status !== 'active';

  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>
        <Link href="/platform/schools">← All schools</Link>
      </p>
      <h1 className="page-title">
        {school.name}{' '}
        <span className={STATUS_PILL[school.status] ?? 'pill'}>{school.status}</span>
      </h1>

      {flash.ok ? <p className="ok">{flash.ok}</p> : null}
      {flash.error ? <p className="error">{flash.error}</p> : null}

      <section className="card">
        <h2>School record</h2>
        <div className="facts">
          <div><span>School name</span><b>{school.name}</b></div>
          <div><span>School code</span><b className="mono">{school.code}</b></div>
          <div>
            <span>Web address</span>
            <b className="mono">
              {school.subdomain ? `${school.subdomain}${process.env.PLATFORM_DOMAIN ? `.${process.env.PLATFORM_DOMAIN}` : ''}` : 'Not set'}
            </b>
          </div>
          <div><span>Contact email</span><b>{school.email ?? '—'}</b></div>
          <div><span>Contact phone</span><b>{school.phone ?? '—'}</b></div>
          <div><span>Address</span><b>{school.address ?? '—'}</b></div>
          <div><span>Created</span><b className="muted">{fmt(school.createdAt)}</b></div>
          <div><span>Last updated</span><b className="muted">{fmt(school.updatedAt)}</b></div>
        </div>
      </section>

      <section className="card">
        <h2>Administrator</h2>
        {school.principalName ? (
          <div className="facts">
            <div><span>Principal</span><b>{school.principalName}</b></div>
            <div><span>Sign-in ID</span><b className="mono">{school.principalLoginId}</b></div>
            <div>
              <span>Account</span>
              <b>{school.principalStatus ?? '—'}</b>
            </div>
          </div>
        ) : (
          <p className="muted">
            No principal is on record for this school. Contact the development
            team to appoint one.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Academic setup</h2>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
          How far the school has set itself up. Counts only — students&apos;
          records live in the school&apos;s own portal.
        </p>
        <div className="stat-grid">
          <div className="stat"><b>{school.setup.academicSessions}</b><span>Academic sessions</span></div>
          <div className="stat"><b>{school.setup.classes}</b><span>Classes</span></div>
          <div className="stat"><b>{school.setup.subjects}</b><span>Subjects</span></div>
          <div className="stat"><b>{school.setup.students}</b><span>Students</span></div>
          <div className="stat"><b>{school.setup.staff}</b><span>Staff</span></div>
        </div>
      </section>

      <section className="card">
        <h2>{suspended ? 'Reactivate this school' : 'Suspend this school'}</h2>

        {suspended ? (
          <>
            <p className="muted" style={{ fontSize: 12.5 }}>
              Reactivating restores sign-in for every active user at the school
              immediately.
            </p>
            <form action={reactivateSchoolAction}>
              <input type="hidden" name="schoolId" value={school.id} />
              <label htmlFor="reactivate-reason">Reason for the record</label>
              <input id="reactivate-reason" name="reason" type="text" placeholder="e.g. Subscription renewed for the term" minLength={10} required />
              <label style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                <input type="checkbox" name="confirm" required />
                <span style={{ fontSize: 13 }}>Confirm reactivation of {school.name}</span>
              </label>
              <button type="submit" style={{ marginTop: 14 }}>Reactivate school</button>
            </form>
          </>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 12.5 }}>
              Suspended immediately: every user at {school.name} is signed out on
              their next request and cannot sign in until reactivation. The
              school&apos;s data is untouched.
            </p>
            <form action={suspendSchoolAction}>
              <input type="hidden" name="schoolId" value={school.id} />
              <label htmlFor="suspend-reason">Reason for the record</label>
              <input id="suspend-reason" name="reason" type="text" placeholder="e.g. Subscription expired at end of term" minLength={10} required />
              <label style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                <input type="checkbox" name="confirm" required />
                <span style={{ fontSize: 13 }}>Confirm suspension of {school.name}</span>
              </label>
              <button type="submit" style={{ marginTop: 14 }}>Suspend school</button>
            </form>
          </>
        )}

        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>
          Schools are never deleted from this screen — a school&apos;s history
          is preserved even after it stops using the platform.
        </p>
      </section>
    </>
  );
}
