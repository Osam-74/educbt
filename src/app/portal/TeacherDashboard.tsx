import Link from 'next/link';
import type { teacherDashboard } from '@/lib/teacher-dashboard';
import { PortalIcon } from './PortalShell';

const STAGES: Record<string, string> = { draft: 'Draft', compiled: 'Compiled', reviewed: 'Reviewed', published: 'Published', locked: 'Locked' };

// Result Pipeline — legacy teacher/index.php's "Result Pipeline" card: one
// coloured box per lifecycle stage with a live count, styled exactly like
// the plugin's inline box (text-align:center, tinted background/border in
// the stage's own colour). The plugin's stages (draft/submitted/approved/
// published) map onto EduCBT's real five-stage lifecycle (see
// src/lib/results/config.ts's resultStateSchema) — one more box than the
// plugin had, because EduCBT's model genuinely has one more stage (locked).
const PIPELINE_STAGES: Array<{ state: string; label: string; color: string }> = [
  { state: 'draft', label: 'Draft', color: '#94a3b8' },
  { state: 'compiled', label: 'Compiled', color: '#f59e0b' },
  { state: 'reviewed', label: 'Reviewed', color: '#3b82f6' },
  { state: 'published', label: 'Published', color: '#16a34a' },
  { state: 'locked', label: 'Locked', color: '#7c3aed' },
];

/**
 * Teacher landing experience (legacy templates/portal/teacher/index.php):
 * stat tiles over real assignments, the CA recording surface one click deep,
 * the classes they head, and the marking queue. Every link points at a route
 * that exists and that the teacher is authorised for — there is no analytics
 * here that the database does not already hold.
 */
export default function TeacherDashboard({ data, canReview }: { data: NonNullable<Awaited<ReturnType<typeof teacherDashboard>>>; canReview: boolean }) {
  const currentTerm = data.term;
  const caHref = (classId: number, subjectId: number) =>
    `/portal/ca?pair=${classId}%3A${subjectId}${currentTerm ? `&termId=${currentTerm.id}` : ''}`;

  // Aggregate every headed class's per-state student counts into one
  // school-wide-for-this-teacher pipeline view — the box grid the plugin's
  // Result Pipeline card shows.
  const pipelineCounts = new Map<string, number>();
  for (const c of data.headed) for (const p of c.pipeline) pipelineCounts.set(p.state, (pipelineCounts.get(p.state) ?? 0) + p.students);
  // Legacy shows this card whenever the teacher heads a class, zero counts
  // and all — hiding it just because nothing has reached a stage yet made an
  // empty pilot class look like the card had never been built.
  const hasPipeline = data.headed.length > 0;

  return <div className="school-dashboard">
    <div className="sd-heading">
      <div>
        <p className="sd-eyebrow">Teaching overview</p>
        <h1>Teacher&rsquo;s Dashboard</h1>
        <p>{data.session?.title ?? 'No current session'} · {data.term?.title ?? 'No current term'}</p>
      </div>
      <Link className="sd-action" href="/portal/ca"><PortalIcon name="edit" />Record CA scores <span aria-hidden="true">↗</span></Link>
    </div>

    <div className="sd-stats">
      <div className="sd-stat"><span className="sd-icon"><PortalIcon name="book" /></span><strong>{data.subjects.reduce((n, s) => n + s.classes.length, 0)}</strong><span>Subject assignments</span></div>
      <div className="sd-stat"><span className="sd-icon"><PortalIcon name="school" /></span><strong>{data.headed.length}</strong><span>Classes headed</span></div>
      <div className="sd-stat"><span className="sd-icon"><PortalIcon name="person" /></span><strong>{data.myStudents}</strong><span>My students</span></div>
      <div className="sd-stat"><span className="sd-icon"><PortalIcon name="check" /></span><strong>{data.marking.outstanding}</strong><span>To mark</span></div>
    </div>

    <div className="sd-panels">
      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="edit" />Record CA</h2>{currentTerm ? <span className="sd-term">{currentTerm.title}</span> : null}</header>
        {data.subjects.length ? <div className="sd-table-wrap"><table>
          <thead><tr><th>Subject</th><th>Class</th><th>Students</th><th>Score sheet</th></tr></thead>
          <tbody>
            {data.subjects.flatMap(s => s.classes.map(c => <tr key={`${s.subjectId}:${c.classId}`}>
              <td>{s.subjectName}</td>
              <td>{c.className}</td>
              <td>{c.students}</td>
              <td><Link href={caHref(c.classId, s.subjectId)}>Open</Link></td>
            </tr>))}
          </tbody>
        </table></div> : <div className="sd-empty">
          <span className="sd-icon"><PortalIcon name="edit" /></span>
          <h3>No subject assignments yet</h3>
          <p>The school office assigns the classes and subjects you teach. Once assigned, each score sheet opens from here.</p>
        </div>}
      </section>

      <section className="sd-panel">
        <header><h2><PortalIcon name="school" />Classes I Head</h2></header>
        {data.headed.length ? <div className="sd-table-wrap"><table>
          <thead><tr><th>Class</th><th>Students</th><th>Results stage</th></tr></thead>
          <tbody>{data.headed.map(c => <tr key={c.classId}>
            <td><Link href={`/portal/students?class=${c.classId}`}>{c.className}</Link></td>
            <td>{c.students}</td>
            <td>{c.pipeline.length
              ? c.pipeline.map(p => <span key={p.state} className={`sd-stage sd-stage-${p.state}`}>{STAGES[p.state] ?? p.state} · {p.students}</span>)
              : <span className="sd-stage">No results yet</span>}</td>
          </tr>)}</tbody>
        </table></div> : <div className="sd-empty">
          <span className="sd-icon"><PortalIcon name="school" /></span>
          <h3>You do not head a class</h3>
          <p>Class teacher is an assignment the office gives, not part of the teacher role. Your subject assignments are in Record CA.</p>
        </div>}
      </section>

      {hasPipeline && <section className="sd-panel">
        <header><h2><PortalIcon name="results" />Result Pipeline</h2>{currentTerm ? <span className="sd-term">{currentTerm.title}</span> : null}</header>
        <div className="sd-panel-body">
          <div className="sd-pipeline-grid">
            {PIPELINE_STAGES.map(({ state, label, color }) => (
              <div key={state} className="sd-pipeline-box" style={{ background: `${color}11`, border: `1px solid ${color}33` }}>
                <strong style={{ color }}>{pipelineCounts.get(state) ?? 0}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="sd-pipeline-actions">
            <Link className="sd-action sd-action--ghost" href="/portal/class-results">View Class Results</Link>
            {canReview && <Link className="sd-action" href="/portal/review">Review Results</Link>}
          </div>
        </div>
      </section>}

      <section className="sd-panel">
        <header><h2><PortalIcon name="check" />Marking queue</h2>{data.marking.outstanding ? <span className="sd-term">{data.marking.outstanding} waiting</span> : null}</header>
        {data.marking.outstanding ? <div className="sd-table-wrap"><table>
          <thead><tr><th>Subject</th><th>Answers to mark</th></tr></thead>
          <tbody>{data.marking.subjects.map(s => <tr key={s.subjectName}>
            <td>{s.subjectName}</td>
            <td>{s.answers}</td>
          </tr>)}</tbody>
        </table></div> : <div className="sd-empty">
          <span className="sd-icon"><PortalIcon name="check" /></span>
          <h3>Nothing to mark</h3>
          <p>Theory answers awaiting your marks will appear here the moment students submit.</p>
        </div>}
        <p className="sd-footnote"><Link href="/portal/marking">Open marking →</Link></p>
      </section>

      <section className="sd-panel">
        <header><h2><PortalIcon name="book" />Question Bank</h2></header>
        <div className="sd-links">
          <Link href="/portal/questions">Questions written: {data.questionsWritten} — open the bank →</Link>
        </div>
      </section>
    </div>
  </div>;
}
