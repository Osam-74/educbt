/**
 * Live exam sessions (legacy templates/portal/exams/invigilate.php, list half).
 *
 * A principal or exam officer watches the whole school; a subject teacher
 * sees the sessions for their subjects; a paper's assigned invigilator sees
 * that paper. The access code travels with the paper so it can be read out.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { livePapers, isWide } from '@/lib/exam/invigilate';
import { fmtDay, fmtTime } from '../exams/labels';

export const dynamic = 'force-dynamic';

export default async function InvigilatePage() {
  const actor = await requireSchoolSession();
  if (actor.role === 'student' || actor.role === 'parent') notFound();

  const papers = await livePapers(actor);

  return (
    <>
      <h1 className="page-title">Live exam sessions</h1>

      {papers.length === 0 ? (
        <p className="muted">
          {isWide(actor)
            ? 'No examination is running right now.'
            : 'No published paper is running right now for your subjects.'}
        </p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Subject</th><th>Class</th><th>When</th><th>Access code</th><th></th></tr>
          </thead>
          <tbody>
            {papers.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.subjectName}</strong></td>
                <td>{p.className ?? p.levelName ?? '—'}</td>
                <td>{fmtDay(p.scheduledAt)}, {fmtTime(p.scheduledAt)}</td>
                <td>{p.accessCode
                  ? <strong style={{ letterSpacing: 1 }}>{p.accessCode}</strong>
                  : <span className="muted">—</span>}</td>
                <td>
                  <Link href={`/portal/invigilate/${p.id}`} className="btn-small">Watch</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
