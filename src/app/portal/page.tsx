import { requireSchoolSession } from '@/lib/session';
import { papersForStudent } from '@/lib/queries';
import { forSchool } from '@/db';
import { guardianChildren } from '@/lib/results/family';

import { schoolDashboard } from '@/lib/portal-dashboard';
import { teacherDashboard } from '@/lib/teacher-dashboard';
import SchoolDashboard from './SchoolDashboard';
import TeacherDashboard from './TeacherDashboard';
import FamilyChildren from './children/FamilyChildren';

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const actor = await requireSchoolSession();

  // The office (principal, vice principal, exam officer) lands on the school
  // overview; a teacher lands on their own teaching surface; a parent lands
  // on their children (legacy made that list the parent dashboard itself).
  // Each service returns null for every other role, so this dispatch can
  // never hand a dashboard to someone whose role does not earn it.
  const dashboard = await schoolDashboard(actor);
  if (dashboard) return <SchoolDashboard data={dashboard} role={actor.role} />;

  const teaching = await teacherDashboard(actor);
  if (teaching) return <TeacherDashboard data={teaching} />;

  if (actor.role === 'parent') {
    const children = await forSchool(actor.schoolId, (tx) => guardianChildren(tx, actor.userId));
    return <>
      <h1 className="page-title">My Children</h1>
      <FamilyChildren children={children} />
    </>;
  }

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

      {actor.role !== 'student' && actor.role !== 'parent' && papers.length === 0 && (
        <p className="muted">Use the navigation to open your available school tools.</p>
      )}
    </>
  );
}
