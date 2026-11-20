'use client';
import { useState, useTransition } from 'react';
import { savePassage, saveEditedPassage, removePassage, previewPassageDelete } from './actions';

export type PassageRow = { id: number; title: string; instructions: string | null; body: string; questions: number };

/**
 * The comprehension-passage panel above the question form. Tick "Comprehension passage" and the
 * instruction and passage boxes appear; once saved, every question written next belongs to that
 * passage. Each saved passage has a pencil (edit) and a bin (delete, with an honest warning).
 */
export default function PassagePanel({
  subjectId, returnParams, passages, selectedId, editable,
}: {
  subjectId: number; returnParams: string; passages: PassageRow[]; selectedId: number; editable: boolean;
}) {
  const [on, setOn] = useState(selectedId > 0);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ id: number; title: string; questions: number; allowed: boolean; reason: string | null } | null>(null);
  const [problem, setProblem] = useState('');
  const [pending, start] = useTransition();
  const selected = passages.find((p) => p.id === selectedId) ?? null;

  function askDelete(p: PassageRow) {
    setProblem('');
    start(async () => {
      const r = await previewPassageDelete(p.id);
      if (!r.ok) { setProblem(r.error); return; }
      setConfirm({ id: r.id, title: r.title, questions: r.questions, allowed: r.allowed, reason: r.reason });
    });
  }

  return (
    <div className="qs-passage" data-testid="passage-panel">
      <label className="qs-passage__tick">
        <input type="checkbox" checked={on} disabled={!editable} onChange={(e) => setOn(e.target.checked)} />
        <span>Comprehension passage</span>
      </label>
      {!on ? <p className="muted qs-passage__hint">Tick this when the questions below are about a passage the students must read.</p> : null}

      {on ? (
        <>
          {passages.length > 0 ? (
            <ul className="qs-passage__list" aria-label="Passages for this subject">
              {passages.map((p) => (
                <li key={p.id} className={p.id === selectedId ? 'is-selected' : ''}>
                  {editing === p.id ? (
                    <form action={saveEditedPassage} className="qs-manual-form qs-passage__edit">
                      <input type="hidden" name="passageId" value={p.id} />
                      <input type="hidden" name="returnParams" value={returnParams} />
                      <label htmlFor={`pt-${p.id}`}>Title</label>
                      <input id={`pt-${p.id}`} name="passageTitle" type="text" defaultValue={p.title} required />
                      <label htmlFor={`pi-${p.id}`}>Instruction (said once, above the passage)</label>
                      <textarea id={`pi-${p.id}`} name="passageInstructions" rows={2} defaultValue={p.instructions ?? ''} />
                      <label htmlFor={`pb-${p.id}`}>Passage</label>
                      <textarea id={`pb-${p.id}`} name="passageBody" rows={8} defaultValue={p.body} required />
                      <div className="qs-passage__actions">
                        <button type="submit" className="sd-action">Save changes</button>
                        <button type="button" className="qs-linkbtn" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <a className="qs-passage__pick" href={`/portal/questions?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(returnParams)), passageId: String(p.id) }).toString()}`}>
                        <strong>{p.title}</strong>
                        <span className="muted"> · {p.questions} question{p.questions === 1 ? '' : 's'}</span>
                        {p.id === selectedId ? <span className="qs-passage__chip">New questions go here</span> : null}
                      </a>
                      {editable ? (
                        <span className="qs-passage__icons">
                          <button type="button" aria-label={`Edit passage ${p.title}`} title="Edit" className="qs-iconbtn" onClick={() => { setEditing(p.id); setConfirm(null); }}>✎</button>
                          <button type="button" aria-label={`Delete passage ${p.title}`} title="Delete" className="qs-iconbtn qs-iconbtn--danger" disabled={pending} onClick={() => askDelete(p)}>🗑</button>
                        </span>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {problem ? <p role="alert" className="error">{problem}</p> : null}

          {confirm ? (
            <div role="alertdialog" aria-label="Confirm delete passage" className="qs-passage__confirm">
              {confirm.allowed ? (
                <>
                  <p>
                    <strong>Delete &ldquo;{confirm.title}&rdquo;?</strong>{' '}
                    {confirm.questions > 0
                      ? <>All {confirm.questions} question{confirm.questions === 1 ? '' : 's'} already written on this passage will be deleted with it. This cannot be undone.</>
                      : <>No questions are written on it yet. This cannot be undone.</>}
                  </p>
                  <form action={removePassage} className="qs-passage__actions">
                    <input type="hidden" name="passageId" value={confirm.id} />
                    <input type="hidden" name="returnParams" value={returnParams} />
                    <button type="submit" className="sd-action qs-danger">Yes, delete{confirm.questions > 0 ? ' passage and questions' : ''}</button>
                    <button type="button" className="qs-linkbtn" onClick={() => setConfirm(null)}>Keep it</button>
                  </form>
                </>
              ) : (
                <>
                  <p><strong>&ldquo;{confirm.title}&rdquo; cannot be deleted.</strong> {confirm.reason}</p>
                  <button type="button" className="qs-linkbtn" onClick={() => setConfirm(null)}>Close</button>
                </>
              )}
            </div>
          ) : null}

          {editable && !selected ? (
            <form action={savePassage} className="qs-manual-form qs-passage__new">
              <input type="hidden" name="subjectId" value={subjectId} />
              <input type="hidden" name="returnParams" value={returnParams} />
              <label htmlFor="passageTitle">Passage title</label>
              <input id="passageTitle" name="passageTitle" type="text" required placeholder="e.g. The Village Market" />
              <label htmlFor="passageInstructions">Instruction (said once, above the passage)</label>
              <textarea id="passageInstructions" name="passageInstructions" rows={2} placeholder="e.g. Read the passage below and answer questions 1 to 4." />
              <label htmlFor="passageBody">Passage</label>
              <textarea id="passageBody" name="passageBody" rows={8} required placeholder="Write or paste the passage here" />
              <button type="submit" className="sd-action">Save passage and add questions</button>
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
