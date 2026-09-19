'use client';
/**
 * Standalone signature and remark-range editors for the Teaching area's
 * separate "Signature" and "Remarks" menu items — legacy parity with
 * teacher/signatures.php and teacher/remarks.php, which are two distinct
 * pages, not one combined tab.
 *
 * School Settings (src/app/portal/settings/SettingsEditor.tsx) keeps its own
 * combined "Signatures & remarks" tab for principal/exam-officer accounts,
 * completely untouched — this file is additive, not a refactor of it, so
 * none of the existing owner-approved behaviour there is at risk.
 *
 * Both editors submit through the SAME settingsAction server action that
 * School Settings uses ('signature' / 'ranges' kinds), just hardcoded to
 * role="class_teacher" — the only role a Teaching-area account ever edits
 * here (see PortalShell.portalAreas: both menu items are gated on
 * role === 'teacher' && classTeacher).
 */
import { useActionState, useRef, useState, type ReactNode } from 'react';
import { settingsAction } from './actions';

function SaveForm({ kind, payload, children, label = 'Save', role, extra }: {
  kind: string; payload: unknown; children: ReactNode; label?: string; role?: string; extra?: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(settingsAction, { ok: false, message: '' });
  return <form action={action}><input type="hidden" name="kind" value={kind}/><input type="hidden" name="payload" value={JSON.stringify(payload)}/>
    {role && <input type="hidden" name="role" value={role}/>}
    {extra && Object.entries(extra).map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}
    <fieldset disabled={pending}>{children}
    <button className="settings-save" type="submit">{pending ? 'Saving…' : label}</button></fieldset>
    {state.message && <p className={state.ok ? 'settings-success' : 'settings-error'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>}</form>;
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }

function SignatureCanvas({ onChange }: { onChange: (dataUrl: string) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const ctx = () => { const c = ref.current!.getContext('2d')!; c.strokeStyle = '#1e293b'; c.lineWidth = 2; c.lineCap = 'round'; return c; };
  const point = (e: React.PointerEvent) => { const c = ref.current!; const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) }; };
  return <div className="settings-canvas-wrap">
    <canvas ref={ref} width={400} height={150} aria-label="Signature drawing area"
      onPointerDown={e => { drawing.current = true; const c = ctx(); const q = point(e); c.beginPath(); c.moveTo(q.x, q.y); }}
      onPointerMove={e => { if (!drawing.current) return; const c = ctx(); const q = point(e); c.lineTo(q.x, q.y); c.stroke(); }}
      onPointerUp={() => { if (drawing.current) { drawing.current = false; onChange(ref.current!.toDataURL()); } }}
      onPointerLeave={() => { if (drawing.current) { drawing.current = false; onChange(ref.current!.toDataURL()); } }}/>
    <button type="button" className="settings-clear" onClick={() => { const c = ref.current!; c.getContext('2d')!.clearRect(0, 0, c.width, c.height); onChange(''); }}>Clear</button>
  </div>;
}

export function SignatureEditor({ signature }: { signature?: { name: string; type: string; data: string } }) {
  const [value, setValue] = useState({ role: 'class_teacher', name: signature?.name ?? '', type: signature?.type ?? 'digital', text: signature?.type === 'text' ? signature.data : '' });
  const [drawn, setDrawn] = useState('');
  return <section className="settings-card">
    <p className="muted">Your signature appears on report sheets for the class(es) you head. Draw, type, or upload it below.</p>
    {signature && <div className="settings-current-signature"><strong>Current signature:</strong><br/>
      {signature.type === 'text'
        ? <span className="settings-signature">{signature.data}</span>
        : <img className="settings-signature-image" src={signature.data} alt="Current signature"/>}
      <small>{signature.name}</small></div>}
    <SaveForm kind="signature" payload={value} label="Save signature" extra={value.type === 'digital' ? { signatureData: drawn } : undefined}><div className="settings-grid">
      <Field label="Display name"><input value={value.name} required maxLength={191} placeholder="e.g. Mr. A. Johnson" onChange={e => setValue({ ...value, name: e.target.value })}/></Field>
      <Field label="Method"><select value={value.type} onChange={e => setValue({ ...value, type: e.target.value })}><option value="digital">Draw on canvas</option><option value="text">Type a text signature</option><option value="upload">Upload image</option></select></Field>
      {value.type === 'digital' && <Field label="Draw signature"><SignatureCanvas onChange={setDrawn}/><small>Draw with your mouse, finger or stylus.</small></Field>}
      {value.type === 'text' && <Field label="Type your signature"><input required maxLength={191} value={value.text} placeholder="Sign here..." className="settings-signature-input" onChange={e => setValue({ ...value, text: e.target.value })}/><span className="settings-signature">{value.text}</span><small>Rendered in a script font on the report sheet.</small></Field>}
      {value.type === 'upload' && <Field label="Upload image"><input type="file" name="image" accept="image/png,image/jpeg" required/><small>Up to 2 MB. Choose a new image to replace the saved signature.</small></Field>}
    </div></SaveForm>
  </section>;
}

export function RangesEditor({ initialRanges }: { initialRanges: { min: number; remark: string }[] }) {
  const [ranges, setRanges] = useState(initialRanges);
  return <section className="settings-card">
    <p className="muted">Set up score ranges and their corresponding remarks. When results are compiled, empty remarks on report cards are auto-filled based on the student's average score. You can still override an individual student's remark on the report sheet. Each range covers scores from its minimum up to — but not including — the next higher minimum.</p>
    <SaveForm kind="ranges" role="class_teacher" payload={ranges} label="Save remark ranges">
      <div className="settings-table"><table><thead><tr><th>Min average</th><th>Up to</th><th>Remark</th><th></th></tr></thead><tbody>
        {ranges.map((r, i) => <tr key={i}><td><input type="number" min="0" max="100" step=".01" value={r.min} onChange={e => setRanges(ranges.map((v, j) => i === j ? { ...v, min: Number(e.target.value) } : v))}/></td>
          <td className="muted">{(() => { const next = ranges.slice(i + 1).map(v => v.min).filter(m => m > r.min).sort((a, b) => a - b)[0]; return next === undefined ? '100' : '< ' + next; })()}</td>
          <td><textarea required maxLength={500} value={r.remark} onChange={e => setRanges(ranges.map((v, j) => i === j ? { ...v, remark: e.target.value } : v))}/></td>
          <td><button type="button" onClick={() => setRanges(ranges.filter((_, j) => i !== j))}>Delete</button></td></tr>)}
      </tbody></table></div>
      <button type="button" disabled={ranges.length >= 30} onClick={() => setRanges([...ranges, { min: 0, remark: '' }])}>Add remark range</button>
    </SaveForm>
  </section>;
}
