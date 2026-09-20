import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { analysisOptions, analysisScopeSchema, subjectAnalysis } from '@/lib/exam/analysis';
import { PairPicker } from '../ca/PairPicker';
import { ComponentPicker } from './ComponentPicker';
import { PrintButton } from './PrintButton';
import '../school-table.css';

export const dynamic = 'force-dynamic';

export default async function AnalysisPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireSchoolSession();
  const options = await analysisOptions(actor);
  if (!options) return <><h1 className="page-title">Subject Results</h1><p>You do not have access to this page.</p></>;

  const noConfig = options.components.length === 0;
  const query = await searchParams;
  const pair = typeof query.pair === 'string' ? query.pair : '';
  const [classId, subjectId] = pair.split(':').map(Number);
  const componentKey = typeof query.component === 'string' && query.component
    ? query.component
    : (options.components[0]?.key ?? '');
  const parsed = analysisScopeSchema.safeParse({ classId, subjectId, componentKey });
  const result = !noConfig && parsed.success ? await subjectAnalysis(actor, parsed.data) : null;

  const component = options.components.find((c) => c.key === componentKey) ?? null;
  const isExam = component?.isExam ?? false;

  return <>
    <h1 className="page-title">Subject Results</h1>

    {!options.pairs.length ? <p className="note">You have not been assigned any subject to teach yet.</p> : <>
      <section className="sa-card no-print">
        {result && !('noTerm' in result) && !('noConfig' in result) && !('noComponent' in result) && (
          <p className="muted" style={{ marginTop: -6 }}>{result.sessionTitle} · {result.termTitle}</p>
        )}
        <form method="get">
          <div className="sa-toolbar" style={{ marginBottom: 14 }}>
            <div>
              <label htmlFor="analysis-pair">Class and subject</label><br />
              <PairPicker pair={pair} pairs={options.pairs} />
            </div>
            {!noConfig && (
              <div>
                <label htmlFor="analysis-component">Assessment</label><br />
                <ComponentPicker value={componentKey} components={options.components} />
              </div>
            )}
          </div>
          <button type="submit" className="sa-btn sa-btn--primary">View</button>
        </form>
      </section>

      {noConfig && <section className="card sa-card">
        <p className="note">Assessment components are not configured. Ask your school administrator to configure them in Settings.</p>
      </section>}

      {!noConfig && component && (
        <section className="card sa-card" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <h2 style={{ margin: 0 }}>{component.label}</h2>
          {result && !('noTerm' in result) && !('noConfig' in result) && !('noComponent' in result) && result.rows.length > 0 && (
            <PrintButton />
          )}
        </section>
      )}

      {!noConfig && parsed.success && !result && (
        <p role="alert" className="error">This selection is unavailable. Check your class/subject assignment.</p>
      )}
      {!noConfig && (!parsed.success || !pair) && (
        <section className="card sa-card"><p className="note">Choose a class and subject to see results.</p></section>
      )}
      {result && 'noTerm' in result && (
        <section className="card sa-card"><p className="note">No current term is set, so results cannot be shown.</p></section>
      )}
      {result && 'noComponent' in result && (
        <section className="card sa-card"><p className="note">That assessment is no longer configured. Pick another.</p></section>
      )}

      {result && !('noTerm' in result) && !('noConfig' in result) && !('noComponent' in result) && (
        <>
          {result.rows.length === 0 ? (
            <section className="card sa-card">
              <p className="note">
                {isExam ? 'No exam has been sat for this subject and class yet, or theory marking is still pending.'
                  : `No scores recorded for ${component?.label ?? 'this assessment'} yet.`}
              </p>
            </section>
          ) : <>
            <section className="stats">
              <div className="stat"><b>{result.stats.count}</b><span>Sat / recorded</span></div>
              <div className="stat"><b>{result.stats.average}%</b><span>Average</span></div>
              <div className="stat"><b>{result.stats.highest}%</b><span>Highest</span></div>
              <div className="stat"><b>{result.stats.passRate}%</b><span>Passed (&ge;40%)</span></div>
            </section>

            <section className="card sa-card">
              <h2>Results, highest first</h2>
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead><tr><th style={{ width: 44 }}>#</th><th>Student</th><th>Score</th><th>Percentage</th><th>Source</th><th /></tr></thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.studentId}>
                        <td>{r.position}</td>
                        <td>{r.name}<br /><span className="muted sa-sub">{r.admissionNumber}</span></td>
                        <td>{r.score} / {r.maxScore}</td>
                        <td><strong>{r.percentage}%</strong></td>
                        <td>{r.cbt ? <span className="sa-pill sa-pill--active">CBT</span> : <span className="muted">entered</span>}</td>
                        <td className="no-print" style={{ whiteSpace: 'nowrap' }}>
                          {r.attemptId && <Link href={`/portal/analysis/${r.attemptId}`} className="sa-btn sa-btn--small">Preview →</Link>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted" style={{ marginTop: 8 }}>
                Equal marks share a position, so two students on 78% are both second and the next is fourth.
              </p>
              {isExam && result.pendingCount > 0 && (
                <p className="note" style={{ marginTop: 12 }}>
                  {result.pendingCount} {result.pendingCount === 1 ? 'attempt is' : 'attempts are'} still awaiting theory marking and
                  are left out of this ranking until marking is complete.
                </p>
              )}
            </section>
          </>}

          {isExam && result.hardestQuestions.length > 0 && (
            <section className="card sa-card">
              <h2>Hardest questions</h2>
              <p className="muted" style={{ marginTop: -6 }}>
                A question almost everyone missed usually says more about the teaching than the students — or the answer key is wrong.
              </p>
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead><tr><th>Question</th><th style={{ width: 130 }}>Got it right</th></tr></thead>
                  <tbody>
                    {result.hardestQuestions.map((q) => (
                      <tr key={q.questionId}>
                        <td>{q.text}</td>
                        <td>{q.rate}% ({q.correct}/{q.answered})</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </>}
  </>;
}
