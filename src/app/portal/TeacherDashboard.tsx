import Link from 'next/link';
import type { teacherDashboard } from '@/lib/teacher-dashboard';
import { PortalIcon } from './PortalShell';

const STAGES: Record<string, string> = { draft: 'Draft', compiled: 'Compiled', reviewed: 'Reviewed', published: 'Published', locked: 'Locked' };

/**
 * Teacher landing experience (legacy templates/portal/teacher/index.php):
 * stat tiles over real assignments, the CA recording surface one click deep,
 * the classes they head, and the marking queue. Every link points at a route
 * that exists and that the teacher is authorised for — there is no analytics
 * here that the database does not already hold.
 */
export default function TeacherDashboard({ data }: { data: NonNullable<Awaited<ReturnType<typeof teacherDashboard>>> }) {
  const currentTerm = data.term;
  const caHref = (classId: number, subjectId: number) =>
    `/portal/ca?pair=${classId}%3A${subjectId}${currentTerm ? `&termId=${currentTerm.id}` : ''}`;

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
