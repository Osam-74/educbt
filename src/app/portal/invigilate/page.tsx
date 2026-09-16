/**
 * Live exam sessions (legacy templates/portal/exams/invigilate.php, list half).
 *
 * A principal or exam officer watches the whole school; a subject teacher
 * sees the sessions for their subjects, plus any paper they are the assigned
 * invigilator for. The access code travels with the paper so it can be read
 * out. Visual parity with the plugin-parity language used across the
 * Examinations area: sd-heading, sd-panel, tbl.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { livePapers, isWide } from '@/lib/exam/invigilate';
import { fmtDay, fmtTime } from '../exams/labels';
import { PortalIcon } from '../PortalShell';

export const dynamic = 'force-dynamic';

export default async function InvigilatePage() {
  const actor = await requireSchoolSession();
  if (actor.role === 'student' || actor.role === 'parent') notFound();

  const wide = isWide(actor);
  const papers = await livePapers(actor);

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>{wide ? 'Live Exam Sessions' : 'My Live Sessions'}</h1>
          <p>
            {wide
              ? 'Every published paper running right now, across the school.'
              : 'Papers running right now for your subjects, plus any you are invigilating.'}
          </p>
        </div>
      </div>

      {papers.length === 0 ? (
        <section className="sd-panel sd-panel--wide">
          <div style={{ padding: 20 }}>
            <p className="muted">
              {wide
                ? 'No examination is running right now.'
                : 'No published paper is running right now for your subjects.'}
            </p>
          </div>
        </section>
      ) : (
        <section className="sd-panel sd-panel--wide">
          <header><h2><PortalIcon name="sessions" />Active examination sessions</h2></header>
          <div className="sd-table-wrap">
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
                      ? <span className="eo-code">{p.accessCode}</span>
                      : <span className="muted">—</span>}</td>
                    <td><Link href={`/portal/invigilate/${p.id}`}>Watch</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
