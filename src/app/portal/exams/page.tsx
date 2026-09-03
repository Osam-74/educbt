import Link from 'next/link';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { listSeries } from '@/lib/exam/compose';
import { TYPE_LABEL, STATUS_LABEL, fmtDay } from './labels';

export const dynamic = 'force-dynamic';

export default async function ExamsPage() {
  const actor = await requireSchoolSession();
  // The menu hides this link for other roles; the server refuses regardless.
  requireRole(actor, SCHOOL_WIDE);

  const series = await listSeries(actor);

  return (
    <>
      <h1 className="page-title">Exam office</h1>

      <p className="muted">
        Create an examination, check the question bank, compose the papers, place
        them on the timetable, and publish — all from one place.
      </p>

      <p style={{ marginTop: 18 }}>
        <Link className="primary-wide" href="/portal/exams/new" style={{ display: 'inline-block' }}>
          Create examination
        </Link>
      </p>

      {series.length === 0 ? (
        <p className="muted">No examinations yet. The first one starts with the button above.</p>
      ) : (
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
      )}
    </>
  );
}
