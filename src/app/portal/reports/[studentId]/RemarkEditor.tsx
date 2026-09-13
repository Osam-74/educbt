'use client';
import { useActionState, useState } from 'react';
import { settingsAction } from '../../settings/actions';
export function RemarkEditor({ studentId, sessionId, termId, role, initial }: { studentId: number; sessionId: number; termId: number; role: string; initial: string }) {
  const [remark, setRemark] = useState(initial);
  const [state, action, pending] = useActionState(settingsAction, { ok: false, message: '' });
  return <details className="no-print" style={{ margin: '12px 0', padding: 12, border: '1px solid #c9d9cc', borderRadius: 8 }}>
    <summary>{role === 'principal' ? 'Principal' : 'Class Teacher'} remark override</summary><form action={action}>
      <input type="hidden" name="kind" value="remark"/><input type="hidden" name="payload" value={JSON.stringify({ studentId, sessionId, termId, role, remark })}/>
      <label>Manual remark (up to 500 characters)<textarea style={{ display: 'block', width: '100%', minHeight: 75 }} maxLength={500} value={remark} onChange={e => setRemark(e.target.value)}/></label>
      <p>Saved text replaces the automatic suggestion and survives recompilation.</p><button disabled={pending}>{pending ? 'Saving…' : 'Save remark'}</button>
      {state.message && <p role={state.ok ? 'status' : 'alert'}>{state.message}</p>}
    </form></details>;
}
