import { redirect } from 'next/navigation';
import { requireSchoolSession, requireRole } from '@/lib/session';
import { practiceFeedback } from '@/lib/exam/practice';

export const dynamic = 'force-dynamic';

// Feedback after submission. The service call does the guarding — this page
// cannot show feedback for a formal exam, another student's attempt, or an
// attempt from another school, because the service refuses all three before
// any answer data is read.
export default async function PracticeFeedbackPage({
  params,
}: {
  params: Promise<{ attemptId: string }>;
}) {
  const actor = await requireSchoolSession();
  requireRole(actor, ['student']);

  const { attemptId } = await params;

  if (!actor.studentId) redirect('/portal');

  const result = await practiceFeedback(
    actor.schoolId,
    Number(attemptId),
    actor.studentId,
  );

  if (!result.ok) {
    return (
      <>
        <h1 className="page-title">No feedback</h1>
        <p className="sub">
          {result.reason === 'not_found' && 'This practice attempt does not exist.'}
          {result.reason === 'not_yours' && 'This practice attempt belongs to another student.'}
          {result.reason === 'formal_exam' && 'Feedback is for practice papers. Examination results are published by your school.'}
          {result.reason === 'not_submitted' && 'Submit the practice paper first — feedback during the paper would give away the answers.'}
        </p>
        <p><a href="/portal/practice">Back to Practice Papers</a></p>
      </>
    );
  }

  const f = result.feedback;

  return (
    <>
      <h1 className="page-title">{f.title}</h1>
      <p className="sub">{f.subjectName} · Practice · submitted {f.submittedAt ? new Date(f.submittedAt).toLocaleString() : ''}</p>

      <div className="stats">
        <div className="stat"><b>{f.score} / {f.maxScore}</b><span>Score</span></div>
        <div className="stat"><b>{f.percentage}%</b><span>Percentage</span></div>
        <div className="stat"><b>{f.numberCorrect} / {f.questions.length}</b><span>Correct</span></div>
        <div className="stat"><b>{f.numberAttempted} / {f.questions.length}</b><span>Attempted</span></div>
      </div>

      <ol className="practice-review">
        {f.questions.map((q) => (
          <li key={q.questionId} className={q.isCorrect ? 'practice-q practice-q--right' : 'practice-q practice-q--wrong'}>
            <p className="practice-q__tag">{q.isCorrect ? 'Correct' : q.attempted ? 'Not correct' : 'Not answered'} · {q.awardedMarks} / {q.marks}</p>
            <p>{q.text}</p>
            <p className="practice-q__answers">
              <span>Your answer: {q.studentOptionText ?? '—'}</span><br />
              <span>Correct answer: {q.correctOptionText ?? '—'}</span>
            </p>
            {q.explanation && <p className="practice-q__explanation">{q.explanation}</p>}
          </li>
        ))}
      </ol>

      <p><a href="/portal/practice">Back to Practice Papers</a></p>
    </>
  );
}
