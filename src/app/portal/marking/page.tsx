/**
 * Marking (legacy templates/portal/exams/marking.php, teacher-marking half).
 *
 * Theory answers wait here for the teacher who owns that subject. Visual
 * parity with the plugin-parity language used across the Examinations area:
 * sd-heading, an eo-status-bar count strip, and the review-card pattern
 * already used for Approve Questions.
 *
 * The legacy template also gives school-wide roles a cross-paper marking
 * progress dashboard; that overview is not built here — markingQueue() is
 * teacher-scoped by design, and this page stays a pure visual pass over the
 * existing backend.
 */

import { redirect } from 'next/navigation';
import { requireSchoolSession, SCHOOL_WIDE } from '@/lib/session';
import { markingQueue, awardMarks } from '@/lib/exam/results';

export const dynamic = 'force-dynamic';

export default async function MarkingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();
  const wide = SCHOOL_WIDE.includes(actor.role as (typeof SCHOOL_WIDE)[number]);
  const queue = await markingQueue(actor);

  async function award(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    const answerId = Number(formData.get('answerId'));
    const marks = Number(formData.get('marks'));

    const result = await awardMarks(inner, answerId, marks);

    redirect(result.ok
      ? '/portal/marking?ok=1'
      : `/portal/marking?error=${encodeURIComponent(result.reason ?? 'Failed.')}`);
  }

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Marking</h1>
          <p>Written answers waiting on you, for the subjects you teach.</p>
        </div>
      </div>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">Marked.</p> : null}

      {queue.length === 0 ? (
        <section className="sd-panel sd-panel--wide">
          <div style={{ padding: 20 }}>
            <p className="muted">
              {wide
                ? 'No written answers are waiting anywhere in the school right now.'
                : 'Nothing to mark. Written answers appear here once a paper has been sat, for the subjects you teach.'}
            </p>
          </div>
        </section>
      ) : (
        <>
          <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
            <div className="eo-status-bar">
              <span><strong>{queue.length}</strong> answer{queue.length === 1 ? '' : 's'} waiting.</span>
            </div>
          </section>

          {queue.map((a) => (
            <section className="eo-review-card" key={a.answerId}>
              <p className="muted" style={{ margin: '0 0 8px' }}>
                {a.subjectName} · {a.studentName}
                <span className="mono"> ({a.admissionNumber})</span>
              </p>
              <h3>{a.questionText}</h3>

              {a.markingGuide ? (
                <p className="note" style={{ marginTop: 10 }}>
                  <strong>Guide:</strong> {a.markingGuide}
                </p>
              ) : null}

              <div className="answer-box" style={{ marginTop: 10 }}>
                {a.textAnswer || <em className="muted">No answer given.</em>}
              </div>

              <form action={award} className="eo-review-card__form">
                <input type="hidden" name="answerId" value={a.answerId} />
                <label htmlFor={`m_${a.answerId}`}>Marks (max {Number(a.maxMarks)})</label>
                <input id={`m_${a.answerId}`} name="marks" type="number"
                       min="0" max={Number(a.maxMarks)} step="0.5"
                       required style={{ maxWidth: 110 }} />
                <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Award</button>
              </form>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
