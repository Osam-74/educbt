import { redirect } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { requireCandidate } from '@/lib/exam/guard';
import { startAttempt } from '@/lib/exam/engine';
import { forSchool, schema } from '@/db';
import ExamRoom from './ExamRoom';

// Never cached. A paper is per-candidate, and a cached one served to the wrong
// student is the worst failure this system can have.
export const dynamic = 'force-dynamic';

const REASON: Record<string, string> = {
  not_published: 'This paper is not open.',
  not_registered: 'You are not registered for this subject, so you cannot sit this paper.',
  already_submitted: 'You have already submitted this paper.',
  no_questions: 'This paper has no questions yet. Tell your teacher.',
  not_scheduled: 'This paper has not been given a timetable slot yet.',
  window_not_open: 'This examination has not started yet. Check your timetable for the day and time.',
  window_closed: 'This examination has closed. It can no longer be started.',
  access_code_required: 'This paper needs the access code your invigilator will read out.',
  access_code_wrong: 'That access code is not right. Check with your invigilator.',
};

export default async function ExamPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string }>;
  searchParams: Promise<{ code?: string }>;
}) {
  const { paperId } = await params;
  const { code } = await searchParams;
  const candidate = await requireCandidate();

  if (!candidate) redirect('/sign-in');

  const result = await startAttempt(
    candidate.schoolId,
    Number(paperId),
    candidate.studentId,
    code,
  );

  // The access-code gate: the candidate cannot read the paper until the
  // invigilator's code is entered. Rendered as its own small form so the
  // wrong-code case re-asks rather than dumping the candidate back.
  if (!result.ok && (result.reason === 'access_code_required' || result.reason === 'access_code_wrong')) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Access code</h1>
          <p className="sub">{REASON[result.reason]}</p>
          <form method="get" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label htmlFor="code">Invigilator&apos;s code</label>
              <input id="code" name="code" type="text" maxLength={16} required
                     autoComplete="off" autoFocus
                     style={{ textTransform: 'uppercase', letterSpacing: 2, width: 180 }} />
            </div>
            <button type="submit">Open paper</button>
          </form>
        </div>
      </main>
    );
  }

  if (!result.ok) {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <h1>Cannot start</h1>
          <p className="sub">{REASON[result.reason] ?? 'This paper is not available.'}</p>
          <p><a href="/portal">Back to your dashboard</a></p>
        </div>
      </main>
    );
  }

  const subjectName = await forSchool(candidate.schoolId, async (tx) => {
    const [row] = await tx
      .select({ name: schema.subjects.name })
      .from(schema.examPapers)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.examPapers.subjectId))
      .where(and(
        eq(schema.examPapers.id, Number(paperId)),
        eq(schema.examPapers.schoolId, candidate.schoolId),
      ))
      .limit(1);

    return row?.name ?? 'Examination';
  });

  return (
    <ExamRoom
      attemptId={result.attemptId}
      expiresAtIso={result.expiresAt.toISOString()}
      subjectName={subjectName}
      questions={result.questions.map((q) => ({
        id: q.id,
        number: q.number,
        text: q.text,
        instructions: q.instructions,
        marks: q.marks,
        options: q.options.map((o) => ({ id: o.id, key: o.key, text: o.text })),
        passage: q.passage ? { title: q.passage.title, body: q.passage.body } : null,
      }))}
    />
  );
}
