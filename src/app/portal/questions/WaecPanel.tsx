import { saveQuestionEdit } from './actions';
import { sectionsFor, sectionProgress, sectionLocked, waecSection } from '@/lib/exam/waec-blueprint';

/**
 * The WAEC structure for a set: how many questions are written in each section, and a way to move a question to
 * another section until it is approved. Server-rendered (no client state), so it works before any script loads.
 */
export function WaecProgress({ examType, questions }: { examType: 'objective' | 'theory'; questions: Array<{ section: string }> }) {
  const { rows, unplaced } = sectionProgress(examType, questions);
  return (
    <section className="qs-waec card" aria-label="WAEC sections">
      <h3 style={{ marginTop: 0 }}>WAEC sections</h3>
      <table className="sa-table qs-waec__table">
        <thead><tr><th>Section</th><th>Written</th><th>Needed</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-section={r.key} data-done={r.done ? 'yes' : 'no'}>
              <td title={r.guide}>{r.label}{r.needsPassage ? <span className="muted"> · needs a passage</span> : null}</td>
              <td>{r.written}</td>
              <td>{r.count}{r.done ? <span className="qs-waec__ok" aria-label="complete"> ✓</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {unplaced > 0 ? (
        <p className="note" data-testid="waec-unplaced">
          {unplaced} question{unplaced === 1 ? ' is' : 's are'} not in a section yet. Choose one for each below.
        </p>
      ) : null}
    </section>
  );
}

/** The section choice on the add form. */
export function SectionSelect({ examType, id = 'section' }: { examType: 'objective' | 'theory'; id?: string }) {
  const list = sectionsFor(examType);
  return (
    <>
      <label htmlFor={id}>WAEC section</label>
      <select id={id} name="section" defaultValue="">
        <option value="">Choose a section…</option>
        {[...new Set(list.map((s) => s.paper))].map((paper) => (
          <optgroup key={paper} label={paper}>
            {list.filter((s) => s.paper === paper).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </optgroup>
        ))}
      </select>
    </>
  );
}

/** Move one question to another section, or say why it cannot be moved any more. */
export function SectionEditor({ question, set, returnParams }: {
  question: { id: number; section: string; approvalStatus: 'pending' | 'approved' | 'revision' };
  set: { status: string; examType: 'objective' | 'theory' };
  returnParams: string;
}) {
  const lock = sectionLocked({ approvalStatus: question.approvalStatus }, { status: set.status });
  const current = waecSection(question.section);
  if (lock.locked) {
    return (
      <span className="muted qs-waec__section" data-testid={`section-locked-${question.id}`} title={lock.reason ?? ''}>
        {current ? current.label : 'No section'} · locked
      </span>
    );
  }
  return (
    <form action={saveQuestionEdit} className="qs-waec__edit" data-testid={`section-form-${question.id}`}>
      <input type="hidden" name="questionId" value={question.id} />
      <input type="hidden" name="returnParams" value={returnParams} />
      <label className="sr-only" htmlFor={`sec-${question.id}`}>Section for this question</label>
      <select id={`sec-${question.id}`} name="section" defaultValue={current ? question.section : ''}>
        <option value="">{question.section && !current ? 'Choose a section…' : 'No section yet'}</option>
        {sectionsFor(set.examType).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      <button type="submit" className="sd-action">Move</button>
    </form>
  );
}
