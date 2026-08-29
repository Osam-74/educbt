import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { and, eq, asc } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { addQuestion, submitSet, isEditable } from '@/lib/exam/sets';
import { snapshotSet } from '@/lib/exam/vault';
import { isSchoolWide } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function AuthorSetPage({
  params,
  searchParams,
}: {
  params: Promise<{ setId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { setId: rawId } = await params;
  const query = await searchParams;
  const actor = await requireSchoolSession();
  const setId = Number(rawId);

  const data = await forSchool(actor.schoolId, async (tx) => {
    const [set] = await tx
      .select({
        id: schema.questionSets.id,
        status: schema.questionSets.status,
        examType: schema.questionSets.examType,
        minRequired: schema.questionSets.minRequired,
        teacherId: schema.questionSets.teacherId,
        seriesId: schema.questionSets.seriesId,
        reviewerComment: schema.questionSets.reviewerComment,
        subjectName: schema.subjects.name,
        levelName: schema.classLevels.name,
      })
      .from(schema.questionSets)
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionSets.subjectId))
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.questionSets.levelId))
      .where(and(
        eq(schema.questionSets.id, setId),
        eq(schema.questionSets.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!set) return null;

    // A teacher may open only their own set. Same response as not-found, so
    // they cannot confirm another teacher's set exists.
    if (!isSchoolWide(actor.role) && set.teacherId !== actor.staffId) return null;

    const questions = await tx
      .select({
        id: schema.questions.id,
        text: schema.questions.questionText,
        marks: schema.questions.marks,
        sequence: schema.questions.sequence,
        approvalStatus: schema.questions.approvalStatus,
        reviewerComment: schema.questions.reviewerComment,
      })
      .from(schema.questions)
      .where(and(
        eq(schema.questions.questionSetId, setId),
        eq(schema.questions.status, 'active'),
      ))
      .orderBy(asc(schema.questions.sequence));

    return { set, questions };
  });

  if (!data) notFound();

  const { set, questions } = data;
  const editable = isEditable(set.status);
  const short = questions.length < set.minRequired;

  async function saveQuestion(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    const back = (msg: string) =>
      redirect(`/portal/questions/${setId}?error=${encodeURIComponent(msg)}`);

    const text = String(formData.get('text') ?? '').trim();

    if (text.length < 5) back('Write the question first.');

    const options = ['a', 'b', 'c', 'd'].map((k) => ({
      text: String(formData.get(`opt_${k}`) ?? '').trim(),
      isCorrect: String(formData.get('correct') ?? '') === k,
    }));

    try {
      await addQuestion(inner, setId, {
        text,
        marks: Number(formData.get('marks') ?? 1) || 1,
        instructions: String(formData.get('instructions') ?? '').trim() || null,
        options,
      });
    } catch (e) {
      back(e instanceof Error ? e.message : 'That question could not be saved.');
    }

    redirect(`/portal/questions/${setId}?ok=saved`);
  }

  async function handIn() {
    'use server';

    const inner = await requireSchoolSession();
    const back = (msg: string) =>
      redirect(`/portal/questions/${setId}?error=${encodeURIComponent(msg)}`);

    let result;

    try {
      result = await submitSet(inner, setId);
    } catch (e) {
      back(e instanceof Error ? e.message : 'That set could not be submitted.');
      return;
    }

    if (!result.success) {
      back(`Not enough questions — ${result.shortfall.join('; ')}.`);
      return;
    }

    // Snapshot at submission. This is the moment the work is finished and worth
    // preserving; questions cannot be recomputed from anything else.
    await snapshotSet(inner.schoolId, setId, 'submitted');

    redirect(`/portal/questions/${setId}?ok=${result.autoApproved ? 'approved' : 'submitted'}`);
  }

  return (
    <>
      <p><Link href="/portal/questions">&larr; Question bank</Link></p>

      <h1 className="page-title">
        {set.subjectName} — {set.levelName}
        <span className="muted" style={{ fontSize: 15, fontWeight: 400 }}>
          {' '}({set.examType === 'objective' ? 'Objective' : 'Theory'})
        </span>
      </h1>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok === 'saved' ? <p className="ok">Question saved.</p> : null}
      {query.ok === 'submitted' ? <p className="ok">Submitted for review.</p> : null}
      {query.ok === 'approved' ? (
        <p className="ok">
          Saved and approved. This assessment does not go through review, so it is
          available to students now.
        </p>
      ) : null}

      {set.status === 'returned' && set.reviewerComment ? (
        <p className="note">
          <strong>Sent back:</strong> {set.reviewerComment}
        </p>
      ) : null}

      <p className={short ? 'short' : 'muted'}>
        {questions.length} of {set.minRequired} question{set.minRequired === 1 ? '' : 's'}
        {short ? ` — ${set.minRequired - questions.length} more needed before you can submit.` : ' — ready to submit.'}
      </p>

      {editable ? (
        <section className="card">
          <h2>Add a question</h2>
          <form action={saveQuestion}>
            {/* Instructions come first: it is the order a candidate reads them,
                and the order the author thinks in. */}
            <label htmlFor="instructions">Instructions (optional)</label>
            <input id="instructions" name="instructions" type="text"
                   placeholder="e.g. Choose the option that best completes the sentence" />

            <label htmlFor="text">Question</label>
            <textarea id="text" name="text" rows={3} required />

            {set.examType === 'objective' ? (
              <>
                <p className="muted" style={{ marginTop: 4 }}>
                  Mark the correct option. A question with no answer key cannot be
                  marked, and that only surfaces after candidates have sat it.
                </p>
                {['a', 'b', 'c', 'd'].map((k) => (
                  <div key={k} className="opt-row">
                    <input type="radio" name="correct" value={k} id={`c_${k}`}
                           defaultChecked={k === 'a'} />
                    <label htmlFor={`c_${k}`} className="opt-key">{k.toUpperCase()}</label>
                    <input type="text" name={`opt_${k}`} placeholder={`Option ${k.toUpperCase()}`} />
                  </div>
                ))}
              </>
            ) : null}

            <label htmlFor="marks">Marks</label>
            <input id="marks" name="marks" type="number" min="1" step="1"
                   defaultValue={1} style={{ maxWidth: 100 }} />

            <button type="submit">Save question</button>
          </form>
        </section>
      ) : (
        <p className="note">
          This set has been submitted and can no longer be edited. Ask the exam
          office to send it back if it needs changing.
        </p>
      )}

      <section className="card">
        <h2>Questions ({questions.length})</h2>
        {questions.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ol className="qlist">
            {questions.map((q) => (
              <li key={q.id}>
                <span>{q.text}</span>
                <span className="muted"> · {Number(q.marks)} mark{Number(q.marks) === 1 ? '' : 's'}</span>
                {q.approvalStatus === 'revision' ? (
                  <div className="note" style={{ marginTop: 6 }}>
                    Sent back{q.reviewerComment ? `: ${q.reviewerComment}` : ''}
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {editable && !short ? (
        <form action={handIn}>
          <button type="submit" className="primary-wide">
            Submit for review
          </button>
          {set.seriesId === 0 ? (
            <p className="muted" style={{ marginTop: 8 }}>
              Objective and theory are submitted together, so both halves must
              meet their minimum.
            </p>
          ) : null}
        </form>
      ) : null}
    </>
  );
}
