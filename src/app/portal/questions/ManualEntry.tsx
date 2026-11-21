import { saveManualQuestion, handInSet } from './actions';
import TheoryParts from './TheoryParts';
import { WaecProgress, SectionSelect, SectionEditor } from './WaecPanel';
import PassagePanel, { type PassageRow } from './PassagePanel';

/**
 * Manual Entry (legacy parity: the entry form under Region B when Method =
 * "Manual Entry" in templates/portal/exams/questions.php). Server-rendered:
 * one question at a time, options only for objective, marks pre-filled from
 * the set's own Default Marks.
 */
export default function ManualEntry({
  set,
  questions,
  returnParams,
  subjectId = 0,
  passages = [],
  selectedPassageId = 0,
}: {
  set: { id: number; examType: string; status: string; minRequired: number; defaultMarks: string; reviewerComment: string | null; waecMode?: boolean };
  questions: Array<{ id: number; text: string; marks: string; approvalStatus: string; reviewerComment: string | null; section?: string; parts?: Array<{ label: string; text: string; marks: string }> }>;
  returnParams: string;
  subjectId?: number;
  passages?: PassageRow[];
  selectedPassageId?: number;
}) {
  const editable = set.status === 'draft' || set.status === 'returned';
  const short = questions.length < set.minRequired;
  const waec = !!set.waecMode;
  const kind = set.examType === 'theory' ? 'theory' : 'objective';

  return (
    <>
      {set.status === 'returned' && set.reviewerComment ? (
        <p className="note"><strong>Sent back:</strong> {set.reviewerComment}</p>
      ) : null}

      <p className={short ? 'short' : 'muted'}>
        {questions.length} of {set.minRequired} question{set.minRequired === 1 ? '' : 's'}
        {short ? ` — ${set.minRequired - questions.length} more needed before you can submit.` : ' — ready to submit.'}
      </p>

      {waec ? <WaecProgress examType={kind} questions={questions.map((q) => ({ section: q.section ?? '' }))} /> : null}

      {subjectId > 0 && set.examType === 'objective' ? (
        <PassagePanel subjectId={subjectId} returnParams={returnParams} passages={passages} selectedId={selectedPassageId} editable={editable} />
      ) : null}

      {editable ? (
        <form action={saveManualQuestion} className="qs-manual-form">
          <input type="hidden" name="setId" value={set.id} />
          <input type="hidden" name="returnParams" value={returnParams} />
          {selectedPassageId > 0 ? <input type="hidden" name="passageId" value={selectedPassageId} /> : null}

          {waec ? <SectionSelect examType={kind} /> : null}

          <label htmlFor="instructions">Instructions (optional)</label>
          <input id="instructions" name="instructions" type="text"
            placeholder="e.g. Choose the option that best completes the sentence" />

          <label htmlFor="text">Question</label>
          <textarea id="text" name="text" rows={3} required />

          {set.examType === 'objective' ? (
            <>
              <p className="muted" style={{ marginTop: 4 }}>Mark the correct option.</p>
              {['a', 'b', 'c', 'd'].map((k) => (
                <div key={k} className="opt-row">
                  <input type="radio" name="correct" value={k} id={`c_${k}`} defaultChecked={k === 'a'} />
                  <label htmlFor={`c_${k}`} className="opt-key">{k.toUpperCase()}</label>
                  <input type="text" name={`opt_${k}`} placeholder={`Option ${k.toUpperCase()}`} />
                </div>
              ))}
            </>
          ) : null}

          <label htmlFor="marks">Marks</label>
          <input id="marks" name="marks" type="number" min={set.examType === 'theory' ? '0.01' : '1'} step={set.examType === 'theory' ? '0.01' : '1'}
            defaultValue={set.examType === 'objective' ? Number(set.defaultMarks) : 1} style={{ maxWidth: 100 }} />

          {set.examType === 'theory' ? <TheoryParts marksInputId="marks" /> : null}
          {set.examType === 'theory' ? (
            <>
              <label htmlFor="markingGuide">Marking guide (optional)</label>
              <textarea id="markingGuide" name="markingGuide" rows={2} placeholder="What a good answer contains, for whoever marks it" />
            </>
          ) : null}

          <button type="submit" className="sd-action">Save question</button>
        </form>
      ) : (
        <p className="note">This set has been submitted and can no longer be edited. Ask the exam office to send it back if it needs changing.</p>
      )}

      <div className="qs-question-list">
        <h3>Questions ({questions.length})</h3>
        {questions.length === 0 ? <p className="muted">None yet.</p> : (
          <ol className="qlist">
            {questions.map((q) => (
              <li key={q.id}>
                <span>{q.text}</span>
                <span className="muted"> · {Number(q.marks)} mark{Number(q.marks) === 1 ? '' : 's'}</span>
                {waec ? <div style={{ marginTop: 6 }}><SectionEditor question={{ id: q.id, section: q.section ?? '', approvalStatus: q.approvalStatus as 'pending' | 'approved' | 'revision' }} set={{ status: set.status, examType: kind }} returnParams={returnParams} /></div> : null}
                {q.parts && q.parts.length > 0 ? (
                  <ul className="muted" style={{ margin: '4px 0 0 18px', listStyle: 'none', padding: 0 }}>
                    {q.parts.map(p => <li key={p.label}>({p.label}) {p.text} <span>· {Number(p.marks)} mark{Number(p.marks) === 1 ? '' : 's'}</span></li>)}
                  </ul>
                ) : null}
                {q.approvalStatus === 'revision' ? (
                  <div className="note" style={{ marginTop: 6 }}>Sent back{q.reviewerComment ? `: ${q.reviewerComment}` : ''}</div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      {editable && !short ? (
        <form action={handInSet}>
          <input type="hidden" name="setId" value={set.id} />
          <input type="hidden" name="returnParams" value={returnParams} />
          <button type="submit" className="sd-action">Submit for review</button>
        </form>
      ) : null}
    </>
  );
}
