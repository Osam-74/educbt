import { requireSchoolSession } from '@/lib/session';
import { schoolStats } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const actor = await requireSchoolSession();

  const stats = await schoolStats(actor);

  return (
    <>
      <h1 className="page-title">Dashboard</h1>

      {stats ? (
        <div className="stat-grid">
          <div className="stat"><b>{stats.students}</b><span>Students</span></div>
          <div className="stat"><b>{stats.staff}</b><span>Staff</span></div>
          <div className="stat"><b>{stats.classes}</b><span>Classes</span></div>
          <div className="stat"><b>{stats.subjects}</b><span>Subjects</span></div>
        </div>
      ) : (
        <p className="muted">
          Your dashboard is being built. Phase 2 brings class lists, subjects and
          the timetable; the question bank follows in Phase 3.
        </p>
      )}

      <p className="muted" style={{ marginTop: 28 }}>
        Phase 1 — foundation. Tenancy, authentication and the academic structure
        are in place and enforced at the database.
      </p>
    </>
  );
}
