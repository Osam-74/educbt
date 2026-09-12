import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { activityPage, activityTitle } from '@/lib/portal-dashboard';

export const dynamic = 'force-dynamic';

/**
 * The full activity log (legacy templates/portal/school/activity.php): the
 * page behind the dashboard's five-event preview. Reaching it is a role
 * question, not a URL question — canViewActivity decides inside the page,
 * and the query itself is school-scoped by the session. A teacher or exam
 * officer typing the URL gets a refusal, never the trail.
 */
export default async function ActivityPage({ searchParams }: {
  searchParams: Promise<{ page?: string }>;
}) {
  const actor = await requireSchoolSession();
  const params = await searchParams;
  const requested = Math.max(1, Number(params.page) || 1);
  const data = await activityPage(actor, requested);

  if (!data) {
    return <>
      <h1 className="page-title">Activity Log</h1>
      <p role="alert">You do not have access to the activity log.</p>
    </>;
  }

  const previous = data.page > 1 ? `/portal/activity?page=${data.page - 1}` : null;
  const next = data.page < data.pages ? `/portal/activity?page=${data.page + 1}` : null;

  return <>
    <h1 className="page-title">Activity Log</h1>
    <p className="muted">Every recorded school update, newest first. {data.total} event{data.total === 1 ? '' : 's'} in total.</p>

    <section className="card">
      {data.rows.length === 0 ? <p className="muted">No activity recorded yet.</p> : <div className="sd-table-wrap"><table>
        <thead><tr><th>Event</th><th>By</th><th>When</th></tr></thead>
        <tbody>
          {data.rows.map(row => <tr key={row.id}>
            <td>
              <strong>{activityTitle(row.action)}</strong>
              <br />
              <span className="muted" style={{ fontSize: 11.5 }}>{row.action}{row.entityType ? ` · ${row.entityType}` : ''}</span>
            </td>
            <td>{row.actorRole ?? 'System'}</td>
            <td>{new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' }).format(row.createdAt)} WAT</td>
          </tr>)}
        </tbody>
      </table></div>}
    </section>

    {data.pages > 1 && <nav className="pager" aria-label="Activity pages" style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
      {previous ? <Link href={previous}>← Previous</Link> : <span className="muted">← Previous</span>}
      <span className="muted">Page {data.page} of {data.pages}</span>
      {next ? <Link href={next}>Next →</Link> : <span className="muted">Next →</span>}
    </nav>}
  </>;
}
