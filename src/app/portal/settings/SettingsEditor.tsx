'use client';
import { useActionState, useRef, useState, type ReactNode } from 'react';
import type { ResultConfig } from '@/lib/results/config';
import { settingsAction } from './actions';

type Session = { id: number; title: string; startsOn: string; endsOn: string; isCurrent: boolean };
type Term = Session & { sessionId: number; position: number };
type Props = { canEdit: boolean; school: { name: string; code: string; address: string | null; phone: string | null; email: string | null; website: string | null; principalName: string | null; logoUrl: string | null; settings: Record<string, unknown> };
  roles: string[]; sessions: Session[]; terms: Term[]; config: ResultConfig; configured: boolean; assessmentInUse: boolean;
  signatures: { role: string; name: string; type: string; data: string }[]; ranges: { role: string; ranges: { min: number; remark: string }[] }[] };
function SaveForm({ kind, payload, children, disabled = false, label = 'Save changes', role, extra }: { kind: string; payload: unknown; children: ReactNode; disabled?: boolean; label?: string; role?: string; extra?: Record<string, string> }) {
  const [state, action, pending] = useActionState(settingsAction, { ok: false, message: '' });
  return <form action={action}><input type="hidden" name="kind" value={kind}/><input type="hidden" name="payload" value={JSON.stringify(payload)}/>
    {role && <input type="hidden" name="role" value={role}/>}
    {extra && Object.entries(extra).map(([name, value]) => <input key={name} type="hidden" name={name} value={value}/>)}
    <fieldset disabled={disabled || pending}>{children}
    {!disabled && <button className="settings-save" type="submit">{pending ? 'Saving…' : label}</button>}</fieldset>
    {state.message && <p className={state.ok ? 'settings-success' : 'settings-error'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>}</form>;
}
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }
const roleLabel = (role: string) => ({ principal: 'Principal', class_teacher: 'Class Teacher', exam_officer: 'Exam Officer' }[role] ?? role);
const sections = ['School profile', 'Session & term', 'Assessments & grading', 'Signatures & remarks'];
export function SettingsEditor(p: Props) {
  const [tab, setTab] = useState(0);
  const [profile, setProfile] = useState({ name: p.school.name, address: p.school.address ?? '', phone: p.school.phone ?? '', email: p.school.email ?? '', website: p.school.website ?? '', principalName: p.school.principalName ?? '' });
  const [sessionId, setSessionId] = useState(p.sessions.find(s => s.isCurrent)?.id ?? p.sessions[0]?.id ?? 0);
  const [termId, setTermId] = useState(p.terms.find(t => t.sessionId === sessionId && t.isCurrent)?.id ?? p.terms.find(t => t.sessionId === sessionId)?.id ?? 0);
  const [newSession, setNewSession] = useState({ title: '', makeCurrent: false });
  const [config, setConfig] = useState(p.config);
  const [duration, setDuration] = useState(Number((p.school.settings.examDefaults as { durationMinutes?: number } | undefined)?.durationMinutes ?? 60));
  const total = config.assessmentComponents.reduce((sum, c) => sum + c.maxScore, 0);
  const component = (i: number, patch: Partial<ResultConfig['assessmentComponents'][number]>) => setConfig({ ...config, assessmentComponents: config.assessmentComponents.map((c, j) => j === i ? { ...c, ...patch } : c) });
  return <div className="school-settings"><header className="settings-heading"><div><p className="settings-eyebrow">SCHOOL MANAGEMENT</p><h1>School Settings</h1><p>School identity, academic rules and the details behind every report.</p></div><span className="settings-badge">{p.canEdit ? 'Principal access' : 'School configuration · view only'}</span></header>
    {!p.canEdit && <p className="settings-notice">The Principal manages school-wide configuration. Your assigned signature and remark settings remain available below.</p>}
    <nav className="settings-tabs" aria-label="Settings sections">{sections.map((name, i) => <button key={name} type="button" aria-current={tab === i ? 'page' : undefined} onClick={() => setTab(i)}>{name}</button>)}</nav>
    {tab === 0 && <section className="settings-card"><h2>School profile & branding</h2><p>These details appear on report cards. The crest is also used as the faint print watermark.</p>
      <SaveForm kind="profile" payload={profile} disabled={!p.canEdit}><div className="settings-grid">
        <Field label="School name"><input value={profile.name} required maxLength={191} onChange={e => setProfile({ ...profile, name: e.target.value })}/></Field>
        <Field label="School code"><input value={p.school.code} readOnly/><small>Permanent reference used by school records.</small></Field>
        <Field label="Principal display name"><input value={profile.principalName} maxLength={191} onChange={e => setProfile({ ...profile, principalName: e.target.value })}/></Field>
        <Field label="Phone"><input type="tel" value={profile.phone} maxLength={50} onChange={e => setProfile({ ...profile, phone: e.target.value })}/></Field>
        <Field label="Email"><input type="email" value={profile.email} maxLength={191} onChange={e => setProfile({ ...profile, email: e.target.value })}/></Field>
        <Field label="Website"><input type="url" value={profile.website} maxLength={191} onChange={e => setProfile({ ...profile, website: e.target.value })}/></Field>
        <Field label="Address"><textarea value={profile.address} maxLength={1000} onChange={e => setProfile({ ...profile, address: e.target.value })}/></Field>
        <div className="settings-logo">{p.school.logoUrl ? <img src={p.school.logoUrl} alt="Current school crest"/> : <span className="settings-empty">No crest uploaded</span>}<Field label="School crest · PNG or JPEG"><input type="file" name="image" accept="image/png,image/jpeg"/><small>Up to 2 MB. Stored as a clean raster image.</small></Field><label><input type="checkbox" name="removeImage" value="true"/> Remove current crest</label></div>
      </div></SaveForm></section>}
    {tab === 1 && <><section className="settings-card"><h2>Current session and term</h2><p>Exams, scores and results are filed under these periods. Changing the current period does not move existing records.</p>
      <SaveForm kind="period" payload={{ sessionId, termId }} disabled={!p.canEdit || !p.sessions.length} label="Set current period"><div className="settings-grid">
        <Field label="Academic session"><select value={sessionId} onChange={e => { const id = Number(e.target.value); setSessionId(id); setTermId(p.terms.find(t => t.sessionId === id)?.id ?? 0); }}>{p.sessions.map(s => <option key={s.id} value={s.id}>{s.title}{s.isCurrent ? ' · current' : ''}</option>)}</select></Field>
        <Field label="Term"><select value={termId} onChange={e => setTermId(Number(e.target.value))}>{p.terms.filter(t => t.sessionId === sessionId).map(t => <option key={t.id} value={t.id}>{t.title}{t.isCurrent ? ' · current' : ''}</option>)}</select></Field>
      </div></SaveForm>{!p.sessions.length && <p className="settings-empty">No academic sessions yet. Create the first session below.</p>}</section>
      <section className="settings-card"><h2>Add a session</h2><p>Three terms are created automatically with the standard calendar dates: First Term 1 Sep – 20 Dec, Second Term 8 Jan – 5 Apr, Third Term 22 Apr – 25 Jul. "2026/27" and "2026-2027" also work — the title normalises to 2026/2027.</p>
        <SaveForm kind="session" payload={newSession} disabled={!p.canEdit} label="Add session"><div className="settings-grid">
          <Field label="Session"><input required placeholder="2026/2027" maxLength={100} value={newSession.title} onChange={e => setNewSession({ ...newSession, title: e.target.value })}/></Field>
        </div><label><input type="checkbox" checked={newSession.makeCurrent} onChange={e => setNewSession({ ...newSession, makeCurrent: e.target.checked })}/> Make this the current session, starting with First Term</label></SaveForm></section></>}
    {tab === 2 && <section className="settings-card"><h2>Assessments, grading and ranking</h2><p>Save these rules together. Existing compiled grades and ranking policies remain stored as originally applied.</p>
      {!p.configured && <p className="settings-notice">Suggested starting values are shown. Review and save them to configure this school.</p>}
      {p.assessmentInUse && <p className="settings-notice">Assessment structure is in use. Labels remain editable; changing keys, maxima or the exam component requires a migration.</p>}
      <SaveForm kind="academic" payload={config} disabled={!p.canEdit} label="Save academic configuration"><h3>How a term is marked</h3>
        <div className="settings-table"><table><thead><tr><th>Name</th><th>Key</th><th>Maximum / weight</th><th>Exam</th><th>Action</th></tr></thead><tbody>{config.assessmentComponents.map((c, i) => <tr key={i}>
          <td><input aria-label={'Component name ' + (i + 1)} value={c.label} onChange={e => component(i, { label: e.target.value })}/></td>
          <td><input aria-label={'Component key ' + (i + 1)} value={c.key} disabled={p.assessmentInUse} onChange={e => component(i, { key: e.target.value })}/></td>
          <td><input aria-label={'Component maximum ' + (i + 1)} type="number" min=".01" max="100" step=".01" value={c.maxScore} disabled={p.assessmentInUse} onChange={e => component(i, { maxScore: Number(e.target.value) })}/></td>
          <td><input aria-label={'Examination component ' + (i + 1)} type="radio" name="examComponent" checked={c.isExam} disabled={p.assessmentInUse} onChange={() => setConfig({ ...config, assessmentComponents: config.assessmentComponents.map((v, j) => ({ ...v, isExam: i === j })) })}/></td>
          <td><button type="button" disabled={p.assessmentInUse || config.assessmentComponents.length < 2} onClick={() => setConfig({ ...config, assessmentComponents: config.assessmentComponents.filter((_, j) => i !== j) })}>Remove</button></td>
        </tr>)}</tbody></table></div><p className={Math.abs(total - 100) < .00001 ? 'settings-success' : 'settings-error'}>Total: {total.toFixed(2)} / 100 · exactly one examination component required</p>
        <button type="button" disabled={p.assessmentInUse || config.assessmentComponents.length >= 20} onClick={() => setConfig({ ...config, assessmentComponents: [...config.assessmentComponents, { key: '', label: '', maxScore: 10, isExam: false }] })}>Add assessment</button>
        <h3>Grading scale</h3><Field label="Scale name"><input value={config.gradingScale.name} required onChange={e => setConfig({ ...config, gradingScale: { ...config.gradingScale, name: e.target.value } })}/></Field>
        <p>Enter each minimum. The maximum is the next higher minimum, exclusive; the highest band includes 100. This covers decimal scores without gaps. Saving a change creates a new version.</p>
        <div className="settings-table"><table><thead><tr><th>Grade</th><th>Minimum</th><th>Upper boundary</th><th>Remark</th><th>Action</th></tr></thead><tbody>{config.gradingScale.bands.map((b, i) => {
          const upper = Math.min(...config.gradingScale.bands.filter(v => v.min > b.min).map(v => v.min), 101);
          const setBand = (patch: Partial<typeof b>) => setConfig({ ...config, gradingScale: { ...config.gradingScale, bands: config.gradingScale.bands.map((v, j) => j === i ? { ...v, ...patch } : v) } });
          return <tr key={i}><td><input aria-label={'Grade ' + (i + 1)} value={b.grade} maxLength={10} onChange={e => setBand({ grade: e.target.value })}/></td><td><input aria-label={'Grade minimum ' + (i + 1)} type="number" min="0" max="100" step=".01" value={b.min} onChange={e => setBand({ min: Number(e.target.value) })}/></td><td>{upper === 101 ? '100 inclusive' : '< ' + upper}</td><td><input aria-label={'Grade remark ' + (i + 1)} value={b.remark} maxLength={100} onChange={e => setBand({ remark: e.target.value })}/></td><td><button type="button" onClick={() => setConfig({ ...config, gradingScale: { ...config.gradingScale, bands: config.gradingScale.bands.filter((_, j) => i !== j) } })}>Remove</button></td></tr>;
        })}</tbody></table></div><button type="button" disabled={config.gradingScale.bands.length >= 30} onClick={() => setConfig({ ...config, gradingScale: { ...config.gradingScale, bands: [...config.gradingScale.bands, { min: 0, grade: '', remark: '' }] } })}>Add grade band</button>
        <h3>Ranking policy</h3><div className="settings-grid"><Field label="Position ties"><select value={config.rankingPolicy.tiePolicy} onChange={e => setConfig({ ...config, rankingPolicy: { ...config.rankingPolicy, tiePolicy: e.target.value as 'competition' } })}><option value="competition">Competition · 1, 1, 3</option><option value="dense">Dense · 1, 1, 2</option><option value="ordinal">Ordinal · 1, 2, 3</option></select></Field>
        <Field label="Tiebreakers in order"><select value={config.rankingPolicy.tiebreakers.join(',') || 'none'} onChange={e => setConfig({ ...config, rankingPolicy: { ...config.rankingPolicy, tiebreakers: e.target.value.split(',') as ('exam' | 'ca' | 'none')[] } })}><option value="none">None</option><option value="exam">Exam score</option><option value="ca">CA score</option><option value="exam,ca">Exam, then CA</option><option value="ca,exam">CA, then exam</option></select></Field></div>
        <label><input type="checkbox" checked={config.rankingPolicy.rankIncomplete} onChange={e => setConfig({ ...config, rankingPolicy: { ...config.rankingPolicy, rankIncomplete: e.target.checked } })}/> Include incomplete results in ranking</label><p>Incomplete results still cannot be published. Ordinal ties ultimately use admission number for a stable order.</p>
      </SaveForm></section>}
    {tab === 2 && <section className="settings-card"><h2>Default exam duration</h2><p>Used to prefill new examinations. Existing papers keep their own settings.</p>
      <SaveForm kind="exam" payload={{ durationMinutes: duration }} disabled={!p.canEdit}><Field label="Default exam duration (minutes)"><input type="number" min="5" max="300" value={duration} onChange={e => setDuration(Number(e.target.value))}/></Field></SaveForm></section>}
    {tab === 3 && <section className="settings-card"><h2>Your signatures & automatic remarks</h2><p>Signatures belong to your linked staff record. Automatic remarks are saved when results are compiled; changing ranges never rewrites a published report.</p>
      {!p.roles.length && <p className="settings-empty">No eligible staff role is linked to this account. A Principal or assigned Class Teacher can maintain report details.</p>}
      {p.roles.map(role => <PersonalEditor key={role} role={role} signature={p.signatures.find(s => s.role === role)} initialRanges={p.ranges.find(r => r.role === role)?.ranges ?? []}/>)}</section>}
  </div>;
}
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
function PersonalEditor({ role, signature, initialRanges }: { role: string; signature?: Props['signatures'][number]; initialRanges: { min: number; remark: string }[] }) {
  // Legacy signatures.php: draw on canvas, type a text signature, or upload an image.
  const [value, setValue] = useState({ role, name: signature?.name ?? '', type: signature?.type ?? 'digital', text: signature?.type === 'text' ? signature.data : '' });
  const [drawn, setDrawn] = useState('');
  const [ranges, setRanges] = useState(initialRanges);
  return <div className="settings-subcard"><h3>{roleLabel(role)}</h3>
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
    {role !== 'exam_officer' && <SaveForm kind="ranges" role={role} payload={ranges} label="Save remark ranges"><h4>Automatic remark ranges</h4>
      <p>Set up score ranges and their corresponding remarks. When results are compiled, empty remarks on report cards are auto-filled based on the student's average score. Minimum thresholds cover scores up to the next higher minimum.</p>
      <div className="settings-table"><table><thead><tr><th>Min average</th><th>Max average</th><th>Remark</th><th></th></tr></thead><tbody>
        {ranges.map((r, i) => <tr key={i}><td><input type="number" min="0" max="100" step=".01" value={r.min} onChange={e => setRanges(ranges.map((v, j) => i === j ? { ...v, min: Number(e.target.value) } : v))}/></td>
          <td className="muted">{ranges.slice(i + 1).some(v => v.min > r.min) ? ranges.slice(i + 1).map(v => v.min).filter(m => m > r.min)[0] : 100}</td>
          <td><textarea required maxLength={500} value={r.remark} onChange={e => setRanges(ranges.map((v, j) => i === j ? { ...v, remark: e.target.value } : v))}/></td>
          <td><button type="button" onClick={() => setRanges(ranges.filter((_, j) => i !== j))}>Delete</button></td></tr>)}
      </tbody></table></div>
      <button type="button" disabled={ranges.length >= 30} onClick={() => setRanges([...ranges, { min: 0, remark: '' }])}>Add remark range</button>
    </SaveForm>}</div>;
}
