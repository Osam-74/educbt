import { requireSchoolSession } from '@/lib/session';
import { papersForStudent } from '@/lib/queries';

import { schoolDashboard } from '@/lib/portal-dashboard';
import SchoolDashboard from './SchoolDashboard';

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const actor = await requireSchoolSession();

  const dashboard = await schoolDashboard(actor);
  if (dashboard) return <SchoolDashboard data={dashboard} role={actor.role}/>;
  const papers = actor.role === 'student' ? await papersForStudent(actor) : [];

  return (
    <>
      <h1 className="page-title">Dashboard</h1>

      {papers.length > 0 ? (
        <section className="card">
          <h2>Your papers</h2>
          {papers.map((p) => {
            const sat = p.attemptStatus && p.attemptStatus !== 'in_progress';

            return (
              <div key={p.paperId} className="paper-row">
                <span>
                  <strong>{p.subjectName}</strong>
                  <span className="muted"> · {p.seriesTitle}</span>
                  <br />
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {Math.round(p.durationSeconds / 60)} minutes
                  </span>
                </span>
                {sat ? (
                  <span className="pill">Submitted</span>
                ) : (
                  <a className="primary-wide" href={`/exam/${p.paperId}`}>
                    {p.attemptStatus === 'in_progress' ? 'Resume' : 'Start'}
                  </a>
                )}
              </div>
            );
          })}
          <p className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>
            Only subjects you are registered for appear here.
          </p>
        </section>
      ) : null}

      {/* Legacy student dashboard had a "Check results" quick action; the
          parent dashboard led with children. Both live one click away. */}
      {actor.role === 'student' ? (
        <section className="card">
          <div className="paper-row">
            <span><strong>Check results</strong><br />
              <span className="muted">Published report sheets for your terms.</span></span>
            <a className="primary-wide" href="/portal/my-results">Open</a>
          </div>
        </section>
      ) : null}
      {actor.role === 'parent' ? (
        <section className="card">
          <div className="paper-row">
            <span><strong>My children</strong><br />
              <span className="muted">Published results for each of your children.</span></span>
            <a className="primary-wide" href="/portal/children">Open</a>
          </div>
        </section>
      ) : null}

      {actor.role !== 'student' && actor.role !== 'parent' && papers.length === 0 && (
        <p className="muted">Use the navigation to open your available school tools.</p>
      )}
    </>
  );
}
