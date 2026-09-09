import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { resultOptions, resultDashboard, ResultError } from '@/lib/results/workflow';
import { canManageResults, resultScopeSchema } from '@/lib/results/config';
import { ResultActions } from './ResultActions';
import './results.css';

export const dynamic = 'force-dynamic';
export default async function ResultsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireSchoolSession();
  if (!canManageResults(actor)) return <><h1 className="page-title">Results</h1><p>You do not have access to the results dashboard.</p></>;
  let options;
  try { options = await resultOptions(actor); } catch (error) {
    if (error instanceof ResultError) return <p role="alert">{error.message}</p>;
    throw error;
  }
  const query = await searchParams;
  const term = options.terms.find(t => t.id === Number(query.termId));
  const parsed = resultScopeSchema.safeParse({ classId: Number(query.classId), sessionId: term?.sessionId, termId: term?.id });
  let data: Awaited<ReturnType<typeof resultDashboard>> | null = null;
  let error = '';
  if (parsed.success) {
    try { data = await resultDashboard(actor, parsed.data); } catch (e) { if (e instanceof ResultError) error = e.message; else throw e; }
  } else if (Object.keys(query).length) error = 'Choose an available class, session and term.';
  const states = data ? [...new Set(data.results.map(r => r.state))] : [];
  const stage = states.length > 1 ? 'mixed' : states[0] ?? 'draft';
  const complete = data?.students.filter(s => {
    const rows = data!.rows.filter(r => r.studentId === s.id);
    return rows.length > 0 && rows.every(r => r.stored?.complete && r.stored.state !== 'draft' && r.complete);
  }).length ?? 0;
  return <div className="results-page">
    <h1 className="page-title">Results</h1>
    <p className="muted">Compile a class, review its results, then publish to students and parents.</p>
    <form method="get" className="card result-filters">
      <div><label htmlFor="results-term">Session and term</label><select id="results-term" name="termId" required defaultValue={term?.id ?? ''}>
        <option value="">Choose session and term</option>{options.terms.map(t => <option key={t.id} value={t.id}>{options.sessions.find(s => s.id === t.sessionId)?.title} — {t.title}</option>)}
      </select></div>
      <div><label htmlFor="results-class">Class / arm</label><select id="results-class" name="classId" required defaultValue={typeof query.classId === 'string' ? query.classId : ''}>
        <option value="">Choose class</option>{options.classes.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
      </select></div><button type="submit">Open results</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
    {!options.classes.length && <p className="note">No active classes are available.</p>}
    {data && <>
      <section className="card">
        <h2>{data.classroom.displayName} <span className="result-stage">{stage === 'draft' && !data.results.length ? 'Not compiled' : stage}</span></h2>
        <p>{data.session.title} · {data.term.title}</p>
        <ol className="result-stages" aria-label="Result lifecycle">{['draft', 'compiled', 'reviewed', 'published', 'locked'].map(s => <li key={s} aria-current={s === stage ? 'step' : undefined}>{s}</li>)}</ol>
        <div className="result-stats">
          <p><strong>{data.students.length}</strong>Enrolled students</p><p><strong>{complete}</strong>Complete compiled results</p>
          <p><strong>{data.students.length - complete}</strong>Incomplete / not compiled</p>
          <p><strong>{data.rows.filter(r => r.caComplete).length} / {data.rows.length}</strong>CA complete (subject entries)</p>
          <p><strong>{data.rows.filter(r => r.examComplete).length} / {data.rows.length}</strong>Exam complete (subject entries)</p>
        </div>
        {!data.config ? <p className="note">Academic settings are incomplete or invalid. Ask the principal to configure assessment components, a grading scale and a ranking policy. Compilation is unavailable until setup is complete.</p> : <>
          <p>Grading: <strong>{data.config.gradingScale.name}</strong> ({data.config.gradingScale.id}, version {data.config.gradingScale.version}).
            Ranking: {data.config.rankingPolicy.tiePolicy}; tiebreakers: {data.config.rankingPolicy.tiebreakers.join(', ') || 'none'};
            incomplete results {data.config.rankingPolicy.rankIncomplete ? 'ranked by school policy' : 'not ranked'}.</p>
          <p className="muted">{data.config.assessmentComponents.map(c => `${c.label}: ${c.maxScore}`).join(' · ')}</p>
        </>}
        {!data.students.length ? <p>No students enrolled in this class for this session.</p> : !data.rows.length ? <p>No active subject registrations. Register the students’ subjects before compiling.</p> :
          <ResultActions key={`${data.scope.classId}:${data.scope.termId}`} scope={data.scope} stage={stage} principal={actor.role === 'principal'} configured={Boolean(data.config)} />}
        <p className="muted">Final review sign-off, publication, locking and correction reversals require the principal. Compilation alone does not publish results.</p>
      </section>
      <section className="card" id="review">
        <h2>Review results</h2>
        <p>Check the stored totals, grades, subject positions and missing marks. Review does not change scores.</p>
        <p><Link href={`/portal/broadsheet?class=${data.scope.classId}&term=${data.scope.termId}`}>Open broadsheet</Link> · <Link href="/portal/ca">CA score entry</Link> · <Link href="/portal/marking">Marking</Link></p>
        <p className="muted">nr = not ranked; – = not compiled or not applicable. Positions below are subject positions, not overall class positions.</p>
        {data.students.map(student => {
          const rows = data!.rows.filter(r => r.studentId === student.id);
          const total = rows.reduce((s, r) => s + Number(r.stored?.total ?? 0), 0);
          return <details key={student.id} open className="result-student">
            <summary>{student.lastName}, {student.firstName} · {student.admissionNumber} · Stored subject total: {total.toFixed(2)} {rows.some(r => !r.complete || !r.stored?.complete) ? '(partial)' : ''}</summary>
            <p><Link href={`/portal/reports/${student.id}?term=${data!.scope.termId}`}>View report card</Link></p>
            {!rows.length ? <p>No registered subjects.</p> : <div className="result-table-wrap"><table>
              <caption className="sr-only">Subject results for {student.firstName} {student.lastName}</caption>
              <thead><tr><th>Subject</th><th>CA</th><th>Exam</th><th>Total</th><th>Grade</th><th>Position</th><th>Stage</th><th>Readiness</th></tr></thead>
              <tbody>{rows.map(row => <tr key={row.subjectId}>
                <th scope="row">{row.subjectName}</th><td>{row.stored?.caTotal ?? '–'}</td><td>{row.stored?.examTotal ?? '–'}</td><td>{row.stored?.total ?? '–'}</td>
                <td>{row.stored?.complete ? row.stored.grade : '–'}</td><td>{row.stored ? row.stored.subjectPosition > 0 ? `${row.stored.subjectPosition} / ${row.stored.classSize}` : 'nr' : '–'}</td>
                <td>{row.stored?.state ?? 'Not compiled'}</td><td>{row.missing.length ? row.missing.join('; ') : row.stored?.state === 'draft' ? 'Recompile after score correction' : 'All components entered'}
                {row.stored && <small>Stored scale: {row.stored.gradingScaleId} v{row.stored.gradingScaleVersion}</small>}</td>
              </tr>)}</tbody>
            </table></div>}
          </details>;
        })}
      </section>
    </>}
  </div>;
}
