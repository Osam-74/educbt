import Link from 'next/link';
import { requirePlatformSession } from '@/lib/platform/session';
import { listSchools } from '@/lib/platform/schools';
import { bestSchoolUrl } from '@/lib/platform/tenant-url';
import { PaIcon } from '../icons';
import { CopyButton } from '../CopyButton';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pa-pill pa-pill--active',
  suspended: 'pa-pill pa-pill--suspended',
  archived: 'pa-pill pa-pill--archived',
};

export default async function SchoolsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const params = await searchParams;
  const actor = await requirePlatformSession();

  const schools = await listSchools(actor, {
    search: params.q?.trim() || undefined,
    status: params.status || undefined,
  });

  const platformDomain = (process.env.PLATFORM_DOMAIN ?? '').toLowerCase() || null;
  const hasFilters = Boolean(params.q || params.status);

  return (
    <div id="schools-directory-view">
      <div className="pa-page-head">
        <div>
          <h1>Schools</h1>
          <p>Directory of all registered institutions, administrators and web access subdomains.</p>
        </div>
        <Link href="/platform/schools/new" id="schools-add-new-btn" className="pa-btn pa-btn--primary">
          <PaIcon name="plus" width={15} height={15} />
          <span>New school</span>
        </Link>
      </div>

      <div className="pa-glass pa-filter-bar">
        <form method="get" className="pa-filter-form">
          <div className="pa-filter-input-wrap">
            <PaIcon name="search" width={16} height={16} />
            <input
              id="schools-search-input"
              type="search"
              name="q"
              defaultValue={params.q ?? ''}
              placeholder="Search name, code or web address"
            />
          </div>
          <select id="schools-status-filter" name="status" defaultValue={params.status ?? ''} className="pa-select">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          <button type="submit" id="schools-filter-submit-btn" className="pa-btn pa-btn--primary">
            <PaIcon name="filter" width={15} height={15} />
            <span>Filter</span>
          </button>
          {hasFilters ? (
            <Link href="/platform/schools" id="schools-reset-filter-btn" className="pa-btn pa-btn--ghost">
              <PaIcon name="refresh" width={14} height={14} />
              <span>Clear</span>
            </Link>
          ) : null}
        </form>
        <div className="pa-filter-summary">
          <span>Showing <strong style={{ color: 'var(--pa-stone-800)' }}>{schools.length}</strong> registered school{schools.length === 1 ? '' : 's'}</span>
          {params.status ? <span style={{ color: 'var(--pa-emerald-800)', fontWeight: 600 }}>Filtered by: {params.status}</span> : null}
        </div>
      </div>

      <div className="pa-glass pa-panel pa-desktop-table">
        <div className="pa-table-wrap">
          <table className="pa-table">
            <thead>
              <tr>
                <th>School</th>
                <th>Code</th>
                <th>Status</th>
                <th>Contact</th>
                <th>Web address</th>
                <th>Administrator</th>
                <th>Created</th>
                <th className="pa-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {schools.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className="pa-empty">
                      <strong>{hasFilters ? 'No schools match' : 'No schools yet'}</strong>
                      <p>{hasFilters ? 'Try a different search or clear the filter.' : 'Create the first school to bring a tenant onto the platform.'}</p>
                      {hasFilters ? (
                        <Link href="/platform/schools" className="pa-btn pa-btn--ghost pa-btn--sm">Clear search filters</Link>
                      ) : (
                        <Link href="/platform/schools/new" className="pa-btn pa-btn--primary pa-btn--sm">Create a school</Link>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                schools.map((s) => {
                  const url = bestSchoolUrl(s, platformDomain);
                  return (
                    <tr key={s.id} id={`schools-row-${s.id}`}>
                      <td>
                        <Link href={`/platform/schools/${s.id}`} className="pa-cell-name" style={{ textDecoration: 'none' }}>
                          <span className="pa-icon-tile"><PaIcon name="building" width={15} height={15} /></span>
                          <span className="pa-cell-title">{s.name}</span>
                        </Link>
                      </td>
                      <td className="pa-num">{s.code}</td>
                      <td><span className={STATUS_PILL[s.status] ?? 'pa-pill'}>{s.status}</span></td>
                      <td style={{ fontSize: 12.5 }}>
                        {s.email || s.phone ? (
                          <>{s.email ?? ''}{s.email && s.phone ? <br /> : null}{s.phone ?? ''}</>
                        ) : <span style={{ color: 'var(--pa-stone-400)' }}>—</span>}
                      </td>
                      <td>
                        {url ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span className="pa-num">{s.customDomain ?? s.subdomain}</span>
                            <CopyButton value={url} label="" />
                          </div>
                        ) : <span style={{ color: 'var(--pa-stone-400)' }}>Not set</span>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {s.principalName ? (
                          <>
                            <div style={{ fontWeight: 600 }}>{s.principalName}</div>
                            <div className="pa-cell-sub">{s.principalLoginId}</div>
                          </>
                        ) : <span style={{ color: 'var(--pa-stone-400)' }}>No principal on record</span>}
                      </td>
                      <td style={{ color: 'var(--pa-stone-500)', fontSize: 12.5 }}>{s.createdAt.toLocaleDateString('en-GB')}</td>
                      <td className="pa-right">
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <Link href={`/platform/schools/${s.id}`} className="pa-btn pa-btn--ghost pa-btn--sm" title="View complete details">
                            <PaIcon name="eye" width={13} height={13} />
                          </Link>
                          <Link
                            href={`/platform/schools/${s.id}#status-action`}
                            className={`pa-btn pa-btn--sm ${s.status === 'active' ? 'pa-btn--outline' : 'pa-btn--ghost'}`}
                            title={s.status === 'active' ? 'Review suspension' : 'Review reactivation'}
                          >
                            {s.status === 'active' ? 'Suspend' : 'Activate'}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pa-mobile-cards">
        {schools.length === 0 ? (
          <div className="pa-glass pa-empty">
            <strong>{hasFilters ? 'No schools match' : 'No schools yet'}</strong>
            <p>{hasFilters ? 'Try another search or status.' : 'Create the first school to bring a tenant onto the platform.'}</p>
          </div>
        ) : (
          schools.map((s) => {
            const url = bestSchoolUrl(s, platformDomain);
            return (
              <div key={s.id} className="pa-glass pa-mobile-card">
                <div className="pa-mobile-card-top">
                  <div className="pa-cell-name">
                    <span className="pa-icon-tile"><PaIcon name="building" width={15} height={15} /></span>
                    <div>
                      <div className="pa-cell-title" style={{ fontSize: 13.5 }}>{s.name}</div>
                      <div className="pa-cell-sub">{s.code}</div>
                    </div>
                  </div>
                  <span className={STATUS_PILL[s.status] ?? 'pa-pill'}>{s.status}</span>
                </div>
                <div className="pa-mobile-card-grid">
                  <div>
                    <span>Admin</span>
                    <span style={{ fontWeight: 600 }}>{s.principalName ?? '—'}</span>
                  </div>
                  <div>
                    <span>Web login</span>
                    {url ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span className="pa-num">{s.customDomain ?? s.subdomain}</span>
                        <CopyButton value={url} label="" />
                      </div>
                    ) : '—'}
                  </div>
                </div>
                <div className="pa-mobile-card-foot">
                  <span style={{ color: 'var(--pa-stone-400)' }}>Created: {s.createdAt.toLocaleDateString('en-GB')}</span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Link href={`/platform/schools/${s.id}`} className="pa-btn pa-btn--ghost pa-btn--sm">Details</Link>
                    <Link href={`/platform/schools/${s.id}#status-action`} className="pa-btn pa-btn--outline pa-btn--sm">
                      {s.status === 'active' ? 'Suspend' : 'Activate'}
                    </Link>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
