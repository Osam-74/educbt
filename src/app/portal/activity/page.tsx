import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { activityFilters, activityPage, activityTitle } from '@/lib/portal-dashboard';
import '../school-table.css';


export const dynamic = 'force-dynamic';

/**
 * The full activity log (legacy templates/portal/school/activity.php): the
 * page behind the dashboard's five-event preview. Reaching it is a role
 * question, not a URL question — canViewActivity decides inside the page,
 * and the query itself is school-scoped by the session, excluding the
 * platform admin's onboarding trail. A teacher or exam officer typing the
 * URL gets a refusal, never the trail. The filter bar follows the platform
 * admin schools page pattern (fields + Filter + Clear + summary).
 */
export default async function ActivityPage({ searchParams }: {
  searchParams: Promise<{ page?: string; action?: string; user?: string; q?: string }>;
}) {
  const actor = await requireSchoolSession();
  const params = await searchParams;
  const requested = Math.max(1, Number(params.page) || 1);
  const filter = {
    q: params.q?.trim() || undefined,
    action: params.action?.trim() || undefined,
    userId: params.user ? Number(params.user) || undefined : undefined,
  };
  const [data, filters] = await Promise.all([
    activityPage(actor, requested, filter),
    activityFilters(actor),
  ]);

  if (!data) {
    return <>
      <h1 className="page-title">Activity Log</h1>
      <p role="alert">You do not have access to the activity log.</p>
    </>;
  }

  const qs = (page: number) => {
    const sp = new URLSearchParams();
    sp.set('page', String(page));
    if (filter.action) sp.set('action', filter.action);
    if (filter.userId) sp.set('user', String(filter.userId));
    if (filter.q) sp.set('q', filter.q);
    return `/portal/activity?${sp.toString()}`;
  };
  const previous = data.page > 1 ? qs(data.page - 1) : null;
  const next = data.page < data.pages ? qs(data.page + 1) : null;
  const filtered = Boolean(filter.action || filter.userId || filter.q);

  const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });
  const detail = (row: { entityType: string | null; entityId: number | null; reason: string | null }) => {
    let out = '';
    if (row.entityType) {
      out = row.entityType.charAt(0).toUpperCase() + row.entityType.slice(1);
      if (row.entityId) out += ` #${row.entityId}`;
    }
    if (row.reason) out += (out ? ' — ' : '') + row.reason;
    return out;
  };

  return <>
    <h1 className="page-title">Activity Log</h1>

    <section className="card sa-card">
      <form method="get" className="sa-toolbar">
        <div className="filter-input-wrap">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="activity-search-input" type="search" name="q" defaultValue={filter.q ?? ''} placeholder="Search action, user or detail"/>
        </div>
        {filters && filters.actions.length > 0 && <select id="activity-action-filter" name="action" defaultValue={filter.action ?? ''}>
          <option value="">All actions</option>
          {filters.actions.map(a => <option key={a} value={a}>{activityTitle(a)}</option>)}
        </select>}
        {filters && filters.actors.length > 0 && <select id="activity-user-filter" name="user" defaultValue={filter.userId ? String(filter.userId) : ''}>
          <option value="">All users</option>
          {filters.actors.map(u => <option key={u.id} value={u.id!}>{u.label}</option>)}
        </select>}
        <button type="submit" id="activity-filter-submit-btn" className="sa-btn sa-btn--small sa-btn--primary">Filter</button>
        {filtered && <Link href="/portal/activity" id="activity-reset-filter-btn" className="sa-btn sa-btn--small">Clear</Link>}
      </form>
      <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 18px' }}>
        Showing <strong>{data.total}</strong> log entr{data.total === 1 ? 'y' : 'ies'}{filtered ? ' for this filter' : ''}
      </p>

      {data.rows.length === 0 ? <p className="sa-empty">No activity recorded{filtered ? ' for this filter' : ' yet'}.</p> : <><div className="sa-table-wrap"><table className="sa-table">
        <thead><tr><th>When</th><th>Action</th><th>By</th><th>Details</th></tr></thead>
        <tbody>
          {data.rows.map(row => <tr key={row.id}>
            <td className="mono">{fmt.format(row.createdAt)} WAT</td>
            <td><strong>{activityTitle(row.action)}</strong></td>
            <td>{row.actorLoginId ?? 'System'}</td>
            <td className="muted">{detail(row) || '—'}</td>
          </tr>)}
        </tbody>
      </table></div>
      <div className="pager">
        {previous
          ? <a className="pager__link" href={previous}>Newer</a>
          : <button type="button" className="pager__link" disabled>Newer</button>}
        <span className="muted">Page {data.page} of {data.pages}</span>
        {next
          ? <a className="pager__link" href={next}>Older</a>
          : <button type="button" className="pager__link" disabled>Older</button>}
      </div></>}
    </section>
  </>;
}
