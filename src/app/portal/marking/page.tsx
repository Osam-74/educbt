import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { markingQueue, awardMarks } from '@/lib/exam/results';

export const dynamic = 'force-dynamic';

export default async function MarkingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();
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
    <>
      <h1 className="page-title">Marking</h1>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">Marked.</p> : null}

      {queue.length === 0 ? (
        <p className="muted">
          Nothing to mark. Written answers appear here once a paper has been sat,
          for the subjects you teach.
        </p>
      ) : (
        <>
          <p className="muted">{queue.length} answer{queue.length === 1 ? '' : 's'} waiting.</p>

          {queue.map((a) => (
            <section className="card" key={a.answerId}>
              <p className="muted" style={{ margin: 0 }}>
                {a.subjectName} · {a.studentName}
                <span className="mono"> ({a.admissionNumber})</span>
              </p>
              <p style={{ fontWeight: 600, margin: '8px 0' }}>{a.questionText}</p>

              {a.markingGuide ? (
                <p className="note" style={{ marginBottom: 10 }}>
                  <strong>Guide:</strong> {a.markingGuide}
                </p>
              ) : null}

              <div className="answer-box">{a.textAnswer || <em className="muted">No answer given.</em>}</div>

              <form action={award} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 12 }}>
                <input type="hidden" name="answerId" value={a.answerId} />
                <div>
                  <label htmlFor={`m_${a.answerId}`}>Marks (max {Number(a.maxMarks)})</label>
                  <input id={`m_${a.answerId}`} name="marks" type="number"
                         min="0" max={Number(a.maxMarks)} step="0.5"
                         required style={{ maxWidth: 110 }} />
                </div>
                <button type="submit">Award</button>
              </form>
            </section>
          ))}
        </>
      )}
    </>
  );
}
