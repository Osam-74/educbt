import Link from 'next/link';
import type { schoolDashboard } from '@/lib/portal-dashboard';
import { activityTitle, activityAllowed } from '@/lib/portal-dashboard';
import { PortalIcon } from './PortalShell';

export default function SchoolDashboard({ data, role }: { data: NonNullable<Awaited<ReturnType<typeof schoolDashboard>>>; role: string }) {
  const title = role === 'principal' ? 'Principal’s Dashboard' : role === 'vice_principal' ? 'Vice Principal’s Dashboard' : 'School Overview';
  const stages: Record<string, string> = { draft: 'Draft', compiled: 'Compiled', reviewed: 'Reviewed', published: 'Published', locked: 'Locked' };
  return <div className="school-dashboard">
    <div className="sd-heading"><div><p className="sd-eyebrow">School overview</p><h1>{title}</h1><p>{data.session?.title ?? 'No current session'} · {data.term?.title ?? 'No current term'}</p></div><Link className="sd-action" href="/portal/results"><PortalIcon name="chart"/>Manage results <span aria-hidden="true">↗</span></Link></div>
    <div className="sd-stats">
      {[{ label: 'Active students', value: data.students, icon: 'school', href: '/portal/students' }, { label: 'Active staff', value: data.staff, icon: 'person', href: '/portal/staff' }, { label: 'Active classes', value: data.classes, icon: 'layers', href: '/portal/classes' }].map(s => <Link className="sd-stat" href={s.href} key={s.label}><span className="sd-icon"><PortalIcon name={s.icon}/></span><strong>{s.value}</strong><span>{s.label}</span></Link>)}
      <div className="sd-stat sd-calendar"><span className="sd-icon"><PortalIcon name="calendar"/></span><strong>{data.session?.title ?? 'Not set'}</strong><span>{data.term?.title ?? 'No current term'}</span></div>
    </div>
    {data.pendingApprovals > 0 && (
      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="clock"/>Pending office actions</h2><span className="sd-term">{data.pendingApprovals} waiting</span></header>
        <div className="sd-links"><Link href="/portal/students?status=pending_approval">Student approvals waiting: {data.pendingApprovals} — review them →</Link></div>
      </section>
    )}
    <div className="sd-panels">
      <section className="sd-panel"><header><h2><PortalIcon name="chart"/>Results Pipeline</h2><span className="sd-term">{data.term?.title ?? 'No current term'}</span></header>
        {data.pipeline.length ? <><div className="sd-table-wrap"><table><thead><tr><th>Class</th><th>Stage</th><th>Students</th></tr></thead><tbody>{data.pipeline.map(row => <tr key={`${row.classId}-${row.state}`}><td><Link href={`/portal/results?classId=${row.classId}&sessionId=${data.session!.id}&termId=${data.term!.id}`}>{row.className}</Link></td><td><span className={`sd-stage sd-stage-${row.state}`}>{stages[row.state]}</span></td><td>{row.students}</td></tr>)}</tbody></table></div><p className="sd-footnote">Students with stored subject results at each stage. A class may appear at multiple stages.</p></> : <div className="sd-empty"><span className="sd-icon"><PortalIcon name="chart"/></span><h3>{data.term ? 'No results compiled yet' : 'No current academic period'}</h3><p>{data.term ? 'Compiled class results will appear here as they move through review and publication.' : 'A current session and term must be configured before the pipeline can be shown.'}</p><Link href="/portal/results">Open results workspace →</Link></div>}
      </section>
      {data.activity !== null && <section className="sd-panel"><header><h2><PortalIcon name="activity"/>Recent Activity</h2>{activityAllowed(role) ? <Link href="/portal/activity">View all →</Link> : <span className="sd-panel-note">Latest 5 events</span>}</header>{data.activity.length ? <ol className="sd-activity">{data.activity.map(event => <li key={event.id}><span className="sd-icon"><PortalIcon name="clock"/></span><div><strong>{activityTitle(event.action)}</strong><time dateTime={event.createdAt.toISOString()}>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }).format(event.createdAt)} WAT</time></div></li>)}</ol> : <div className="sd-empty"><span className="sd-icon"><PortalIcon name="activity"/></span><h3>No activity recorded yet</h3><p>School updates will appear here as your team gets to work.</p></div>}</section>}
    </div>
  </div>;
}
