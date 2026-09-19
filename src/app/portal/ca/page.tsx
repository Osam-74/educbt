import { requireSchoolSession } from '@/lib/session';
import { caOptions, caFullSheet } from '@/lib/ca/queries';
import { caSheetScopeSchema } from '@/lib/ca/validation';
import { ScoreSheet } from './ScoreSheet';
import { PairPicker } from './PairPicker';
import '../school-table.css';

export const dynamic = 'force-dynamic';

export default async function CaPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireSchoolSession();
  const options = await caOptions(actor);
  if (!options) return <><h1 className="page-title">Record Scores</h1><p>You do not have access to score entry.</p></>;
  // Checked up front (not just inside the resolved sheet) so the guidance
  // shows immediately on page load, before any class/subject is picked.
  const noConfig = options.components.length === 0;
  const query = await searchParams;
  const pair = typeof query.pair === 'string' ? query.pair : '';
  const [classId, subjectId] = pair.split(':').map(Number);
  const parsed = caSheetScopeSchema.safeParse({ classId, subjectId });
  const sheet = !noConfig && parsed.success ? await caFullSheet(actor, parsed.data) : null;

  return <>
    <h1 className="page-title">Record Scores</h1>
    <p className="muted">All assessment components are shown together. CBT exam marks appear automatically and are read-only.</p>
    {!options.pairs.length ? <p className="note">You have not been assigned any subject to teach yet. The school office assigns these under Staff.</p> :
      <section className="sa-card">
        <form method="get">
          <label htmlFor="ca-pair">Class and subject</label>
          <PairPicker pair={pair} pairs={options.pairs} />
          <noscript><button type="submit" className="sa-btn" style={{ marginTop: 10 }}>Load</button></noscript>
        </form>
      </section>}

    {noConfig && <section className="sa-card">
      <p className="note">Assessment components are not configured. Ask your school administrator to configure them in Settings.</p>
    </section>}
    {!noConfig && parsed.success && !sheet && <p role="alert" className="error">This score sheet is unavailable. Check your selection and current assignments.</p>}
    {sheet && sheet.noTerm && <section className="sa-card">
      <p className="note">No current term is set, so scores cannot be recorded.</p>
    </section>}
    {sheet && !sheet.noTerm && !sheet.noConfig && <section className="sa-card" style={{ marginTop: 16 }}>
      <h2>{sheet.className} — {sheet.subjectName}</h2>
      <p className="muted" style={{ marginTop: -6 }}>{sheet.sessionTitle} · {sheet.termTitle}</p>
      {!sheet.students.length ? <p className="note">No students are registered for that subject in that class.</p> :
        !sheet.students.some(s => s.editable) ? <p className="note">
          Results for this class have been reviewed, published or locked. Score entry is closed.
        </p> : null}
    </section>}
    {sheet && !sheet.noTerm && !sheet.noConfig && sheet.students.length > 0 && parsed.success && <ScoreSheet
      classId={parsed.data.classId} subjectId={parsed.data.subjectId}
      sessionId={sheet.sessionId} termId={sheet.termId}
      components={sheet.components} students={sheet.students} />}
  </>;
}
