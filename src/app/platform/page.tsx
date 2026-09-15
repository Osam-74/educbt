import Link from 'next/link';
import { requirePlatformSession } from '@/lib/platform/session';
import { platformOverview } from '@/lib/platform/schools';
import { PaIcon } from './icons';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pa-pill pa-pill--active',
  suspended: 'pa-pill pa-pill--suspended',
  archived: 'pa-pill pa-pill--archived',
};

export default async function PlatformDashboard() {
  const actor = await requirePlatformSession();
  const overview = await platformOverview(actor);

  return (
    <div id="platform-dashboard-view">
      <div className="pa-page-head">
        <div>
          <h1>Platform dashboard</h1>
          <p>Global monitoring for registered school instances and access control.</p>
        </div>
        <Link href="/platform/schools/new" id="dashboard-new-school-cta" className="pa-btn pa-btn--primary">
          <PaIcon name="plus" width={15} height={15} />
          <span>New school</span>
        </Link>
      </div>

      {overview.total === 0 ? (
        <section className="pa-card pa-glass pa-empty" id="dashboard-empty-state">
          <strong>No schools yet</strong>
          <p>
            When a school joins the platform, it is created here — with its first
            principal, ready to sign in. Nothing is added by hand behind the scenes.
          </p>
          <Link href="/platform/schools/new" className="pa-btn pa-btn--primary">
            <PaIcon name="plus" width={15} height={15} />
            <span>Create the first school</span>
          </Link>
        </section>
      ) : (
        <>
          <div className="pa-stat-grid">
            <Link href="/platform/schools" id="stat-card-total-schools" className="pa-glass pa-stat">
              <div className="pa-stat-top">
                <span className="pa-stat-label">Total schools</span>
                <span className="pa-stat-icon pa-stat-icon--emerald"><PaIcon name="building" /></span>
              </div>
              <div className="pa-stat-value">{overview.total}</div>
              <div className="pa-stat-desc">Schools registered on platform</div>
            </Link>

            <Link href="/platform/schools?status=active" id="stat-card-active-schools" className="pa-glass pa-stat">
              <div className="pa-stat-top">
                <span className="pa-stat-label">Active</span>
                <span className="pa-stat-icon pa-stat-icon--active"><PaIcon name="checkCircle" /></span>
              </div>
              <div className="pa-stat-value">
                {overview.active}
                <span className="pa-chip pa-chip--online">Online</span>
              </div>
              <div className="pa-stat-desc">Active and accessible for principals</div>
            </Link>

            <Link href="/platform/schools?status=suspended" id="stat-card-suspended-schools" className="pa-glass pa-stat">
              <div className="pa-stat-top">
                <span className="pa-stat-label">Suspended</span>
                <span className="pa-stat-icon pa-stat-icon--muted"><PaIcon name="alert" /></span>
              </div>
              <div className="pa-stat-value">
                {overview.suspended}
                <span className="pa-chip pa-chip--muted">{overview.suspended === 0 ? 'None' : 'Restricted'}</span>
              </div>
              <div className="pa-stat-desc">Sign-on locked or under review</div>
            </Link>
          </div>

          <section className="pa-glass pa-panel" id="recently-created-card" style={{ marginBottom: 20 }}>
            <div className="pa-panel-head">
              <div>
                <h2>Recently created</h2>
                <p>Latest school tenants provisioned onto EduCBT</p>
              </div>
              <Link href="/platform/schools" id="view-all-schools-btn" className="pa-panel-link">
                View directory <PaIcon name="chevronRight" width={14} height={14} />
              </Link>
            </div>

            {overview.recent.length === 0 ? (
              <div className="pa-empty"><p>No schools have been created yet.</p></div>
            ) : (
              <div className="pa-table-wrap">
                <table className="pa-table">
                  <thead>
                    <tr>
                      <th>School</th>
                      <th>Code</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th className="pa-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recent.map((s) => (
                      <tr key={s.id} id={`recent-school-row-${s.id}`}>
                        <td>
                          <Link href={`/platform/schools/${s.id}`} className="pa-cell-name" style={{ textDecoration: 'none' }}>
                            <span className="pa-icon-tile"><PaIcon name="building" width={15} height={15} /></span>
                            <span className="pa-cell-title">{s.name}</span>
                          </Link>
                        </td>
                        <td className="pa-num">{s.code}</td>
                        <td><span className={STATUS_PILL[s.status] ?? 'pa-pill'}>{s.status}</span></td>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--pa-stone-600)', fontSize: 12.5 }}>
                            <PaIcon name="calendar" width={13} height={13} />
                            {s.createdAt.toLocaleDateString('en-GB')}
                          </span>
                        </td>
                        <td className="pa-right">
                          <Link href={`/platform/schools/${s.id}`} className="pa-btn pa-btn--ghost pa-btn--sm">
                            <PaIcon name="eye" width={13} height={13} /> Details
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <div className="pa-note" id="platform-note-banner">
        <PaIcon name="info" width={16} height={16} />
        <p>
          The platform area manages schools and their sign-on. Academic records
          belong to each school and are not shown here.
        </p>
      </div>
    </div>
  );
}
