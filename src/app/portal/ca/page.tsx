import { requireSchoolSession } from '@/lib/session';
import { caOptions, caRoster } from '@/lib/ca/queries';
import { caScopeSchema } from '@/lib/ca/validation';
import { ScoreForm } from './ScoreForm';

export const dynamic = 'force-dynamic';

export default async function CaPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireSchoolSession();
  const options = await caOptions(actor);
  if (!options) return <><h1 className="page-title">CA score entry</h1><p>You do not have access to CA score entry.</p></>;
  const query = await searchParams;
  const pair = typeof query.pair === 'string' ? query.pair : '';
  const termId = typeof query.termId === 'string' ? Number(query.termId) : 0;
  const componentKey = typeof query.componentKey === 'string' ? query.componentKey : '';
  const [classId, subjectId] = pair.split(':').map(Number);
  const term = options.terms.find(t => t.id === termId);
  const parsed = caScopeSchema.safeParse({ classId, subjectId, sessionId: term?.sessionId, termId, componentKey });
  const sheet = parsed.success ? await caRoster(actor, parsed.data) : null;
  const requested = Object.keys(query).length > 0;

  return <>
    <h1 className="page-title">CA score entry</h1>
    <p className="muted">Choose a class, subject, term and assessment component. Save each student's score separately.
      Zero is a score; a blank entry remains unassessed.</p>
    {!options.components.length ? <p className="note">CA components are not configured.
      Ask your school administrator to configure the assessment components and maximum scores.</p> : !options.pairs.length ?
      <p className="note">No active subject and class assignments are available for you.</p> :
      <form method="get" className="card">
        <label htmlFor="ca-pair">Class and subject</label>
        <select id="ca-pair" name="pair" required defaultValue={pair}>
          <option value="">Choose class and subject</option>
          {options.pairs.map(p => <option key={p.classId + ':' + p.subjectId} value={p.classId + ':' + p.subjectId}>
            {p.className} — {p.subjectName} ({p.subjectCode})
          </option>)}
        </select>
        <label htmlFor="ca-term">Session and term</label>
        <select id="ca-term" name="termId" required defaultValue={termId || ''}>
          <option value="">Choose session and term</option>
          {options.terms.map(t => <option key={t.id} value={t.id}>
            {options.sessions.find(s => s.id === t.sessionId)?.title} — {t.title}
          </option>)}
        </select>
        <label htmlFor="ca-component">Assessment component</label>
        <select id="ca-component" name="componentKey" required defaultValue={componentKey}>
          <option value="">Choose component</option>
          {options.components.map(c => <option key={c.key} value={c.key}>{c.label} — out of {c.maxScore}</option>)}
        </select>
        <button type="submit" style={{ marginTop: 12 }}>Open score sheet</button>
      </form>}
    {requested && !sheet ? <p role="alert" className="error">This score sheet is unavailable. Check your selection and current assignments.</p> : null}
    {sheet && parsed.success ? <section>
      <h2>{sheet.className} — {sheet.subjectName}</h2>
      <p>{sheet.sessionTitle} · {sheet.termTitle} · {sheet.component.label} / {sheet.component.maxScore}</p>
      <p className="muted">Only active, enrolled students registered for this subject in this session appear.
        Reviewed, published and locked results cannot be edited here.</p>
      {!sheet.rows.length ? <p className="note">No eligible students are registered in this scope.</p> : null}
      {sheet.rows.map(row => <article className="card" key={pair + ':' + termId + ':' + componentKey + ':' + row.studentId}>
        <h3>{row.lastName}, {row.firstName} <span className="mono">({row.admissionNumber})</span></h3>
        {row.editable ? <ScoreForm scope={parsed.data} studentId={row.studentId}
          name={row.firstName + ' ' + row.lastName} score={row.score} maxScore={sheet.component.maxScore} /> :
          <p>Score: {row.score ?? 'Not entered'} — read only ({row.state ?? 'published'}).
            Reopen the result through the review workflow before editing.</p>}
        {row.updatedAt ? <p className="muted">Last saved: {row.updatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC</p> : null}
      </article>)}
    </section> : null}
  </>;
}
