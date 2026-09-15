import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { activityFilters, activityPage, activityTitle } from '@/lib/portal-dashboard';


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
  searchParams: Promise<{ page?: string; action?: string; user?: string }>;
}) {
  const actor = await requireSchoolSession();
  const params = await searchParams;
  const requested = Math.max(1, Number(params.page) || 1);
  const filter = {
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
    return `/portal/activity?${sp.toString()}`;
  };
  const previous = data.page > 1 ? qs(data.page - 1) : null;
  const next = data.page < data.pages ? qs(data.page + 1) : null;
  const filtered = Boolean(filter.action || filter.userId);
  const hasFilterOptions = Boolean(filters && (filters.actions.length || filters.actors.length));

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

    {hasFilterOptions && <div className="filter-bar">
      <form method="get" className="filter-form">
        {filters!.actions.length > 0 && <label className="filter-field">
          <span>Action type</span>
          <select name="action" defaultValue={filter.action ?? ''}>
            <option value="">All actions</option>
            {filters!.actions.map(a => <option key={a} value={a}>{activityTitle(a)}</option>)}
          </select>
        </label>}
        {filters!.actors.length > 0 && <label className="filter-field">
          <span>User</span>
          <select name="user" defaultValue={filter.userId ? String(filter.userId) : ''}>
            <option value="">All users</option>
            {filters!.actors.map(u => <option key={u.id} value={u.id!}>{u.label}</option>)}
          </select>
        </label>}
        <button type="submit" className="filter-submit">Filter</button>
        {filtered && <Link href="/portal/activity" className="filter-clear">Clear</Link>}
      </form>
      <div className="filter-summary">
        <span>Showing <strong>{data.total}</strong> log entr{data.total === 1 ? 'y' : 'ies'}{filtered ? ' for this filter' : ''}</span>
      </div>
    </div>}

    {!hasFilterOptions && <p className="muted">{data.total} log entr{data.total === 1 ? 'y' : 'ies'}.</p>}

    <section className="card">
      {data.rows.length === 0 ? <p className="muted">No activity recorded{filtered ? ' for this filter' : ' yet'}.</p> : <><div className="table-wrap"><table className="tbl">
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
