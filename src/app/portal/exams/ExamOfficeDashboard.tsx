import Link from 'next/link';
import type { ExamOfficeDashboard as DashboardData } from '@/lib/exam/dashboard';
import { PortalIcon } from '../PortalShell';
import { fmtDay } from './labels';

const STAT_ICON: Record<string, string> = {
  questions: 'questions',
  papers: 'papers',
  published: 'check',
  sat: 'chart',
  theoryPending: 'marking',
};

const STAT_LABEL: Record<string, string> = {
  questions: 'Questions',
  papers: 'Total papers',
  published: 'Published',
  sat: 'Sat & graded',
  theoryPending: 'Answers to mark',
};

export default function ExamOfficeDashboard({ data }: { data: DashboardData }) {
  const { heading, subheading, stats, pipeline, upcoming, recentSittings } = data;
  const doneCount = pipeline.filter((p) => p.state === 'done').length;

  const tiles: Array<keyof typeof stats> = ['questions', 'papers', 'published', 'sat'];
  if (stats.theoryPending > 0) tiles.push('theoryPending');

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>{heading}</h1>
          <p>{subheading}</p>
        </div>
        <Link className="sd-action" href="/portal/exams/papers">
          <PortalIcon name="exam" />Create examination
        </Link>
      </div>

      <div className="eo-stats">
        {tiles.map((key) => (
          <div className="eo-stat" key={key}>
            <span className={`eo-icon${key === 'theoryPending' ? ' eo-icon--warn' : ''}`}>
              <PortalIcon name={STAT_ICON[key]!} />
            </span>
            <strong>{stats[key]}</strong>
            <span>{STAT_LABEL[key]}</span>
          </div>
        ))}
      </div>

      {pipeline.length > 0 ? (
        <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
          <header>
            <h2><PortalIcon name="clock" />This term&rsquo;s examination</h2>
            <span className="sd-term">{doneCount} of {pipeline.length} stages complete</span>
          </header>
          <ol className="eo-pipeline">
            {pipeline.map((stage, i) => (
              <li className={`eo-pipe eo-pipe--${stage.state}`} key={stage.label}>
                <span className="eo-pipe__num">{i + 1}</span>
                <span className="eo-pipe__text">
                  <strong>{stage.label}</strong>
                  <span>{stage.note}</span>
                </span>
                <Link className="eo-pipe__go" href={stage.href}>{stage.action} →</Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="sd-panels">
        <section className="sd-panel">
          <header>
            <h2><PortalIcon name="timetable" />Next papers</h2>
            <Link href="/portal/timetable" className="sd-panel-note" style={{ fontWeight: 600, color: '#193a26' }}>Timetable →</Link>
          </header>
          {upcoming.length === 0 ? (
            <div className="sd-empty">
              <span className="sd-icon"><PortalIcon name="timetable" /></span>
              <h3>Nothing scheduled</h3>
              <p>Create the examination for a term, then teachers submit their questions against it.</p>
            </div>
          ) : (
            <div className="sd-table-wrap">
              <table>
                <thead><tr><th>Subject</th><th>Class</th><th>When</th><th>Type</th><th>Status</th></tr></thead>
                <tbody>
                  {upcoming.map((p) => (
                    <tr key={p.id}>
                      <td><strong>{p.subjectName}</strong></td>
                      <td>{p.className ?? '—'}</td>
                      <td>{fmtDay(p.scheduledAt)}</td>
                      <td><span className={`pill ${p.isPractice ? 'pill--draft' : 'pill--approved'}`}>{p.isPractice ? 'CA' : 'Exam'}</span></td>
                      <td><span className={`pill pill--${p.status}`}>{p.status[0]!.toUpperCase() + p.status.slice(1)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="sd-panel">
          <header>
            <h2><PortalIcon name="marking" />Recent sittings</h2>
            <Link href="/portal/marking" className="sd-panel-note" style={{ fontWeight: 600, color: '#193a26' }}>Marking →</Link>
          </header>
          {recentSittings.length === 0 ? (
            <div className="sd-empty">
              <span className="sd-icon"><PortalIcon name="marking" /></span>
              <h3>No exams have been sat yet</h3>
              <p>Sittings appear here once students start submitting papers.</p>
            </div>
          ) : (
            <div className="sd-table-wrap">
              <table>
                <thead><tr><th>Subject</th><th>Type</th><th>Class</th><th>Sat</th><th>Graded</th><th>Progress</th></tr></thead>
                <tbody>
                  {recentSittings.map((s) => (
                    <tr key={s.id}>
                      <td><strong>{s.subjectName}</strong></td>
                      <td><span className={`pill ${s.isPractice ? 'pill--draft' : 'pill--approved'}`}>{s.isPractice ? 'CA' : 'Exam'}</span></td>
                      <td>{s.className ?? '—'}</td>
                      <td>{s.sat}</td>
                      <td>{s.graded}</td>
                      <td>
                        <span className="eo-progress">
                          <span className="eo-progress__bar"><span className="eo-progress__fill" style={{ width: `${s.pct}%` }} /></span>
                          <span className="eo-progress__text">{s.pct}%</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="sd-panel sd-panel--wide" style={{ marginTop: 22 }}>
        <header><h2><PortalIcon name="grid" />Examination management</h2></header>
        <div className="eo-links">
          <Link className="eo-link" href="/portal/exams/approvals">Approve questions</Link>
          <Link className="eo-link" href="/portal/timetable">Timetable</Link>
          <Link className="eo-link" href="/portal/invigilation">Invigilation</Link>
          <Link className="eo-link" href="/portal/marking">Marking status</Link>
          <Link className="eo-link" href="/portal/questions">Question Bank</Link>
        </div>
      </section>
    </div>
  );
}
