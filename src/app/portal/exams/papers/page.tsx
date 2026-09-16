import Link from 'next/link';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { listSeries } from '@/lib/exam/compose';
import { PortalIcon } from '../../PortalShell';
import { TYPE_LABEL, STATUS_LABEL, fmtDay } from '../labels';

export const dynamic = 'force-dynamic';

/**
 * Exam Papers (legacy templates/portal/exams/papers.php, $educbt_title = 'Exam Papers').
 *
 * The plugin's page mixes the practice-exam toggle, the single question-bank
 * window switch and separate CA/examination creation forms — all superseded
 * here by one composition model where every series (examination, CA test or
 * practice) carries its own question window and its own create flow at
 * /portal/exams/new. This page is where the office comes to browse and open
 * every one of them, exactly like the plugin's page is where it comes to
 * browse and create every one of them — same job, same place in the menu.
 */
export default async function ExamPapersPage() {
  const actor = await requireSchoolSession();
  // The menu hides this link for other roles; the server refuses regardless.
  requireRole(actor, SCHOOL_WIDE);

  const series = await listSeries(actor);

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Exam Papers</h1>
          <p>
            Every examination, CA test and practice paper ever created for this school —
            check the question bank, compose the papers, place them on the timetable, and publish.
          </p>
        </div>
        <Link className="sd-action" href="/portal/exams/new">
          <PortalIcon name="exam" />Create examination
        </Link>
      </div>

      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="papers" />All examinations</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {series.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>
              No examinations yet. Use &ldquo;Create examination&rdquo; above to start the first one.
            </p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th><th>Type</th><th>Papers</th>
                    <th>Sitting window</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.id}>
                      <td>{s.title}</td>
                      <td>{TYPE_LABEL[s.seriesType] ?? s.seriesType}</td>
                      <td>
                        {s.paperCount}
                        {s.paperCount > 0 && s.unscheduledCount > 0 && s.seriesType !== 'practice' ? (
                          <span className="tag">{' '}{s.unscheduledCount} unscheduled</span>
                        ) : null}
                      </td>
                      <td>
                        {s.seriesType === 'practice' ? (
                          <span className="muted">Always available</span>
                        ) : (
                          `${fmtDay(s.sittingOpensAt)} – ${fmtDay(s.sittingClosesAt)}`
                        )}
                      </td>
                      <td>
                        <span className={`pill pill--${
                          s.status === 'published' ? 'published'
                            : s.status === 'draft' ? 'draft'
                              : 'submitted'
                        }`}>
                          {STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      </td>
                      <td><Link href={`/portal/exams/${s.id}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
