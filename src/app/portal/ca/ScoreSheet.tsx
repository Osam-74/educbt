'use client';

import { useActionState } from 'react';
import { saveCaSheet, type SaveState } from './actions';
import type { CaSheetCell, CaSheetRow } from '@/lib/ca/queries';
import type { AssessmentComponent } from '@/domain/academic';

/** Two lines, not three: the name and its maximum are what the marker needs. */
function shortLabel(label: string) {
  return label
    .replace(/first ca test/i, 'CA 1').replace(/second ca test/i, 'CA 2').replace(/third ca test/i, 'CA 3')
    .replace(/continuous assessment/i, 'CA').replace(/\s*test\b/i, '');
}

export function ScoreSheet({ classId, subjectId, sessionId, termId, components, students }: {
  classId: number; subjectId: number; sessionId: number; termId: number;
  components: AssessmentComponent[]; students: CaSheetRow[];
}) {
  const [state, action, pending] = useActionState<SaveState, FormData>(saveCaSheet, { ok: false, message: '' });
  const anyEditable = students.some(s => s.editable);

  return <form action={action} className="card sa-card">
    <input type="hidden" name="classId" value={classId} />
    <input type="hidden" name="subjectId" value={subjectId} />
    <input type="hidden" name="sessionId" value={sessionId} />
    <input type="hidden" name="termId" value={termId} />
    {components.map(c => <input key={c.key} type="hidden" name={`max[${c.key}]`} value={c.maxScore} />)}

    <div className="sa-table-wrap">
      <table className="sa-table">
        <thead>
          <tr>
            <th style={{ whiteSpace: 'nowrap' }}>Adm. no.</th>
            <th style={{ whiteSpace: 'nowrap' }}>Student</th>
            {components.map(c => <th key={c.key} style={{ width: 100, textAlign: 'center', whiteSpace: 'nowrap' }}>
              {shortLabel(c.label)}
              <span className="muted" style={{ fontWeight: 400, fontSize: '.78em', display: 'block' }}>
                /{c.maxScore}{c.isExam ? ' · CBT' : ''}
              </span>
            </th>)}
            <th style={{ textAlign: 'center' }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {students.map(row => <tr key={row.studentId}>
            <td><code>{row.admissionNumber}</code></td>
            <td style={{ whiteSpace: 'nowrap' }}>{row.lastName}, {row.firstName}</td>
            {components.map(c => <ScoreCell key={c.key} row={row} component={c} cell={row.cells[c.key]!} pending={pending} />)}
            <td style={{ textAlign: 'center', fontWeight: 600 }}>{row.total.toFixed(1)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>

    <p className="muted" style={{ marginTop: 10 }}>
      Leave a box empty for a student you have not marked yet — that is different from a zero.
      CBT exam marks are shown automatically and cannot be edited here.
    </p>
    <p role="status" aria-live="polite" className={state.ok ? 'ok' : state.message ? 'error' : 'muted'}>{state.message}</p>
    {anyEditable && <button type="submit" className="sa-btn sa-btn--primary" disabled={pending} style={{ marginTop: 8 }}>
      {pending ? 'Saving…' : 'Save scores'}
    </button>}
  </form>;
}

function ScoreCell({ row, component, cell, pending }: {
  row: CaSheetRow; component: AssessmentComponent; cell: CaSheetCell; pending: boolean;
}) {
  if (!row.editable || !cell.editable) {
    return <td style={{ textAlign: 'center' }}>
      {cell.score !== null
        ? <strong>{cell.score.toFixed(1)}</strong>
        : <span className="muted" style={{ fontSize: '.78rem' }}>{cell.waiting ?? (row.editable ? '—' : 'Locked')}</span>}
    </td>;
  }
  return <td style={{ textAlign: 'center' }}>
    <input type="number" step="0.01" min={0} max={component.maxScore}
      name={`score[${row.studentId}][${component.key}]`} defaultValue={cell.score ?? ''}
      disabled={pending} placeholder="—" style={{ width: 76, padding: 6, textAlign: 'center' }}
      aria-label={`${component.label} for ${row.firstName} ${row.lastName}`} />
  </td>;
}
