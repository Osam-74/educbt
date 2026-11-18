'use client';
import { useActionState } from 'react';
import { settingsAction } from '../settings/actions';

export type NotesRow = { studentId: number; name: string; remark: string; source: string | null; present: number; total: number; locked: boolean };

/** One pupil: the class teacher's remark and the days present, saved together. Its own form so one pupil's mistake never blocks another's save. */
export function TermNotesRow({ row, sessionId, termId }: { row: NotesRow; sessionId: number; termId: number }) {
  const [state, action, pending] = useActionState(settingsAction, { ok: false, message: '' });
  const id = `notes-${row.studentId}`;
  return <tr>
    <th scope="row">{row.name}{row.source === 'imported' ? <span className="muted"> (from your old site)</span> : null}</th>
    <td colSpan={4}>
      <form action={action} className="notes-form">
        <input type="hidden" name="kind" value="termNotes"/>
        <input type="hidden" name="payload" value={JSON.stringify({ studentId: row.studentId, sessionId, termId })}/>
        <NotesFields id={id} row={row} locked={row.locked || pending}/>
        {row.locked
          ? <span className="muted">Results are under review, so this is locked.</span>
          : <button className="sa-btn" type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save'}</button>}
        {state.message ? <span className={state.ok ? 'notes-ok' : 'notes-error'} role={state.ok ? 'status' : 'alert'}>{state.message}</span> : null}
      </form>
    </td>
  </tr>;
}
/** The server action reads one JSON payload, so these inputs are folded into it on submit. */
function NotesFields({ id, row, locked }: { id: string; row: NotesRow; locked: boolean }) {
  return <>
    <label htmlFor={`${id}-remark`} className="sr-only">Remark for {row.name}</label>
    <textarea id={`${id}-remark`} name="remark" defaultValue={row.remark} maxLength={500} rows={2} disabled={locked} placeholder="Class teacher's remark"/>
    <label htmlFor={`${id}-present`} className="sr-only">Days present for {row.name}</label>
    <input id={`${id}-present`} name="present" type="number" min={0} max={366} step={1} defaultValue={row.total ? row.present : ''} disabled={locked} placeholder="Present"/>
    <span aria-hidden="true">of</span>
    <label htmlFor={`${id}-total`} className="sr-only">Days school was open for {row.name}</label>
    <input id={`${id}-total`} name="total" type="number" min={0} max={366} step={1} defaultValue={row.total || ''} disabled={locked} placeholder="Days open"/>
  </>;
}
