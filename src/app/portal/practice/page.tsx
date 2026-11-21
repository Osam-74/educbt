import { requireSchoolSession, requireRole } from '@/lib/session';
import { practicePapersFor, type PracticePaperRow } from '@/lib/exam/practice';
import { forSchool } from '@/db';
import { schoolTimeZone } from '@/lib/calendar/service';

export const dynamic = 'force-dynamic';

/** "Fri 21 Nov, 9:00 am" on the school's own clock, not the server's. */
function when(iso: string, zone: string): string {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone });
}

function windowNote(p: PracticePaperRow, zone: string): string | null {
  if (p.windowState === 'not_open' && p.opensAt) return `Opens ${when(p.opensAt, zone)}`;
  if (p.windowState === 'closed' && p.closesAt) return `Closed ${when(p.closesAt, zone)}`;
  if (p.windowState === 'open' && p.closesAt) return `Open until ${when(p.closesAt, zone)}`;
  return null;
}

// Student-facing practice area. Deliberately separate from the dashboard's
// formal paper list: practice never counts towards results, and showing the
// two side by side invites a student to treat a practice paper as an exam.
export default async function PracticePage() {
  const actor = await requireSchoolSession();
  requireRole(actor, ['student']);

  const zone = await forSchool(actor.schoolId, (tx) => schoolTimeZone(tx, actor.schoolId));
  const papers = actor.studentId
    ? await practicePapersFor(actor.schoolId, actor.studentId)
    : [];

  const available = papers.filter((p) => p.attemptStatus === null);
  const inProgress = papers.filter((p) => p.attemptStatus === 'in_progress');
  const done = papers.filter((p) => p.attemptStatus === 'submitted' || p.attemptStatus === 'auto_submitted');

  return (
    <>
      <h1 className="page-title">Practice Papers</h1>
      <p className="sub">
        Practice does not count towards your results. Use it to learn — you get
        feedback on every question as soon as you submit.
      </p>

      <h2>Available Practice</h2>
      {available.length === 0 ? (
        <p className="sub">No practice papers yet. Your teachers will add them.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Subject</th><th>Practice</th><th>Questions</th><th>Time</th><th></th></tr>
          </thead>
          <tbody>
            {available.map((p) => (
              <tr key={p.paperId} data-window={p.windowState}>
                <td>{p.subjectName} <span className="muted">({p.subjectCode})</span></td>
                <td>{p.seriesTitle}{windowNote(p, zone) ? <div className="muted" data-testid={`window-note-${p.paperId}`}>{windowNote(p, zone)}</div> : null}</td>
                <td>{p.questionCount}</td>
                <td>{Math.round(p.durationSeconds / 60)} min</td>
                <td>{p.windowState === 'open'
                  ? <a className="primary-wide" href={`/exam/${p.paperId}`}>Start Practice</a>
                  : <span className="muted" data-testid={`window-${p.windowState}-${p.paperId}`}>{p.windowState === 'closed' ? 'Closed' : 'Not open yet'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>In Progress</h2>
      {inProgress.length === 0 ? (
        <p className="sub">Nothing in progress.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Subject</th><th>Practice</th><th></th></tr>
          </thead>
          <tbody>
            {inProgress.map((p) => (
              <tr key={p.paperId}>
                <td>{p.subjectName} <span className="muted">({p.subjectCode})</span></td>
                <td>{p.seriesTitle}</td>
                <td><a className="primary-wide" href={`/exam/${p.paperId}`}>Resume Practice</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Completed Practice</h2>
      {done.length === 0 ? (
        <p className="sub">You have not completed any practice yet.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Subject</th><th>Practice</th><th>Score</th><th></th></tr>
          </thead>
          <tbody>
            {done.map((p) => (
              <tr key={p.paperId}>
                <td>{p.subjectName} <span className="muted">({p.subjectCode})</span></td>
                <td>{p.seriesTitle}</td>
                <td>{p.score ?? '—'}</td>
                <td>
                  {p.attemptId !== null && (
                    <a className="primary-wide" href={`/portal/practice/${p.attemptId}/feedback`}>
                      View Feedback
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
