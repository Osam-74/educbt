'use client';

import { useState } from 'react';

type Row = { key: number; label: string; text: string; marks: string };

/**
 * Optional labelled parts for a theory question, e.g. (a) 2 marks and (b) 3 marks. Parts only describe how the
 * question's marks are split, so their total must equal the Marks box above. The running total says so before the
 * teacher saves; the server checks again and has the final word. Leaving every row empty saves a plain question.
 */
export default function TheoryParts({ marksInputId }: { marksInputId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [next, setNext] = useState(1);
  const [questionMarks, setQuestionMarks] = useState<number | null>(null);

  const read = () => {
    const el = document.getElementById(marksInputId) as HTMLInputElement | null;
    setQuestionMarks(el ? Number(el.value) || 0 : null);
  };
  const total = Math.round(rows.reduce((sum, r) => sum + (Number(r.marks) || 0) * 100, 0)) / 100;
  const filled = rows.some(r => r.label.trim() || r.text.trim() || r.marks.trim());
  const matches = questionMarks !== null && Math.round(total * 100) === Math.round(questionMarks * 100);
  const letter = (i: number) => String.fromCharCode(97 + (i % 26));
  const update = (key: number, patch: Partial<Row>) => setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <fieldset className="qs-parts" onFocus={read} style={{ border: '1px solid var(--line, #d9ddd5)', borderRadius: 8, padding: '10px 12px', margin: '10px 0' }}>
      <legend style={{ padding: '0 6px' }}>Parts (optional)</legend>
      <p className="muted" style={{ marginTop: 0 }}>Split this question into parts such as (a) and (b). Their marks must add up to the question&rsquo;s marks.</p>
      {rows.map((r, i) => (
        <div key={r.key} style={{ display: 'grid', gridTemplateColumns: '56px 1fr 84px auto', gap: 8, marginBottom: 6 }}>
          <input type="text" name={`part_label_${r.key}`} value={r.label} maxLength={10} aria-label={`Label for part ${i + 1}`} onChange={e => update(r.key, { label: e.target.value })} />
          <input type="text" name={`part_text_${r.key}`} value={r.text} placeholder="What this part asks" aria-label={`Text of part ${i + 1}`} onChange={e => update(r.key, { text: e.target.value })} />
          <input type="number" name={`part_marks_${r.key}`} value={r.marks} min="0.01" step="0.01" placeholder="Marks" aria-label={`Marks for part ${i + 1}`} onChange={e => { update(r.key, { marks: e.target.value }); read(); }} />
          <button type="button" className="sa-btn" onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))} aria-label={`Remove part ${i + 1}`}>Remove</button>
        </div>
      ))}
      <button type="button" className="sa-btn" onClick={() => { read(); setRows(rs => [...rs, { key: next, label: letter(rs.length), text: '', marks: '' }]); setNext(n => n + 1); }}>Add a part</button>
      {filled ? (
        <p role="status" className={matches ? 'muted' : 'short'} style={{ marginBottom: 0 }}>
          Parts add up to {total}{questionMarks !== null ? ` of ${questionMarks}` : ''}{matches ? '. Good.' : '. They must match the question\u2019s marks.'}
        </p>
      ) : null}
    </fieldset>
  );
}
