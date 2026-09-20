import { requireSchoolSession } from '@/lib/session';
import { attemptResponses } from '@/lib/exam/analysis';
import '../../school-table.css';

export const dynamic = 'force-dynamic';

// Hidden from the Teaching nav — reached only via the "Preview →" link on a
// student's own Subject Results row. Legacy parity: templates/portal/teacher/responses.php.
export default async function ResponsePreviewPage({ params }: {
  params: Promise<{ attemptId: string }>;
}) {
  const actor = await requireSchoolSession();
  const { attemptId } = await params;
  const attempt = await attemptResponses(actor, Number(attemptId));

  if (!attempt) {
    return <><h1 className="page-title">Responses</h1><p className="note">Attempt not found, or you do not hold this class and subject.</p></>;
  }

  let lastPassage: string | null = null;

  return <>
    <h1 className="page-title">Responses — {attempt.studentName}</h1>
    <section className="card sa-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <p className="muted" style={{ margin: 0 }}>{attempt.admissionNumber} · {attempt.subjectName} · {attempt.typeLabel}</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 28, fontWeight: 700, color: attempt.percentage >= 40 ? '#166534' : '#991b1b' }}>
            {attempt.percentage}%
          </div>
          <div className="muted" style={{ fontSize: '.85rem' }}>
            {attempt.score} / {attempt.maxScore}
            {attempt.status === 'auto_submitted' || attempt.status === 'submitted' ? (
              attempt.questions.some((q) => q.type === 'theory' && q.awarded === null) ? ' · Awaiting theory marking' : ' · Graded'
            ) : null}
          </div>
        </div>
      </div>
      {attempt.submittedAt && <p className="muted" style={{ margin: '6px 0 0', fontSize: '.8rem' }}>
        Submitted {new Date(attempt.submittedAt).toLocaleString()}
      </p>}
    </section>

    <section className="card sa-card">
      <h2>Responses ({attempt.questions.length} questions)</h2>
      {attempt.questions.length === 0 ? <p className="muted">No questions found for this attempt.</p> : (
        <div style={{ display: 'grid', gap: 0 }}>
          {attempt.questions.map((q) => {
            const showPassage = q.passageTitle && q.passageTitle !== lastPassage;
            if (showPassage) lastPassage = q.passageTitle;
            return (
              <div key={q.questionId}>
                {showPassage && (
                  <div className="answer-box" style={{ margin: '18px 0 10px' }}>
                    <h3 style={{ fontSize: '.95rem', margin: '0 0 6px' }}>{q.passageTitle}</h3>
                    <div style={{ fontSize: '.85rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{q.passageBody}</div>
                  </div>
                )}
                <div style={{ borderBottom: '1px solid #e2e8e4', padding: '16px 0' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <span style={{ fontWeight: 700, color: '#666', minWidth: 28 }}>{q.number}.</span>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: '0 0 10px', fontWeight: 500 }}>{q.text}</p>
                      {q.imageUrl && <img src={q.imageUrl} alt="" style={{ maxWidth: 300, borderRadius: 6, marginBottom: 10 }} />}

                      {q.type === 'theory' ? (
                        <div className="answer-box">
                          {q.textAnswer ? q.textAnswer : <span className="muted">No answer submitted.</span>}
                        </div>
                      ) : (
                        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                          {q.options.map((o) => (
                            <li key={o.id} style={{
                              padding: '8px 12px', borderRadius: 6, border: '1px solid #e2e8e4',
                              background: o.isCorrect ? '#dcfce7' : o.chosen ? '#fee2e2' : 'var(--white)',
                              fontWeight: o.chosen || o.isCorrect ? 600 : 400,
                            }}>
                              {o.text}
                              {o.isCorrect && <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>(correct answer)</span>}
                              {o.chosen && !o.isCorrect && <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>(student's answer)</span>}
                              {o.chosen && o.isCorrect && <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>(student's answer)</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                      <p className="muted sa-sub" style={{ marginTop: 8 }}>
                        {q.awarded !== null ? `${q.awarded} / ${q.marks} marks` : `Not yet marked · ${q.marks} marks available`}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  </>;
}
