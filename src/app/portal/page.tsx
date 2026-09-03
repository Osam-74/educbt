import { requireSchoolSession } from '@/lib/session';
import { schoolStats, papersForStudent } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const actor = await requireSchoolSession();

  const stats = await schoolStats(actor);
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
