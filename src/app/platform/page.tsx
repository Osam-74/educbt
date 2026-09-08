import Link from 'next/link';
import { requirePlatformSession } from '@/lib/platform/session';
import { platformOverview } from '@/lib/platform/schools';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pill pill--active',
  suspended: 'pill pill--suspended',
  archived: 'pill pill--withdrawn',
};

export default async function PlatformDashboard() {
  const actor = await requirePlatformSession();
  const overview = await platformOverview(actor);

  return (
    <>
      <h1 className="page-title">Platform dashboard</h1>

      {overview.total === 0 ? (
        <section className="card">
          <h2>No schools yet</h2>
          <p className="muted">
            When a school joins the platform, it is created here — with its
            first principal, ready to sign in. Nothing is added by hand behind
            the scenes.
          </p>
          <p>
            <Link href="/platform/schools/new" className="primary-wide">
              Create the first school
            </Link>
          </p>
        </section>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat"><b>{overview.total}</b><span>Schools</span></div>
            <div className="stat"><b>{overview.active}</b><span>Active</span></div>
            <div className="stat"><b>{overview.suspended}</b><span>Suspended</span></div>
          </div>

          <section className="card">
            <h2>Recently created</h2>
            {overview.recent.length === 0 ? (
              <p className="muted">No schools have been created yet.</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>School</th>
                    <th>Code</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.recent.map((s) => (
                    <tr key={s.id}>
                      <td><Link href={`/platform/schools/${s.id}`}>{s.name}</Link></td>
                      <td className="mono">{s.code}</td>
                      <td><span className={STATUS_PILL[s.status] ?? 'pill'}>{s.status}</span></td>
                      <td className="muted">{s.createdAt.toLocaleDateString('en-GB')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            The platform area manages schools and their sign-on. Academic
            records belong to each school and are not shown here.
          </p>
        </>
      )}
    </>
  );
}
