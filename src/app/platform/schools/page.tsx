import Link from 'next/link';
import { requirePlatformSession } from '@/lib/platform/session';
import { listSchools } from '@/lib/platform/schools';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  active: 'pill pill--active',
  suspended: 'pill pill--suspended',
  archived: 'pill pill--withdrawn',
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

  return (
    <>
      <h1 className="page-title">Schools</h1>

      <div className="filters">
        <form method="get">
          <input
            type="search"
            name="q"
            defaultValue={params.q ?? ''}
            placeholder="Search name, code or web address"
          />
          <select name="status" defaultValue={params.status ?? ''}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
          <button type="submit">Filter</button>
        </form>
      </div>

      {schools.length === 0 ? (
        <section className="card">
          <h2>{params.q || params.status ? 'No schools match' : 'No schools yet'}</h2>
          <p className="muted">
            {params.q || params.status
              ? 'Try a different search or clear the filter.'
              : 'Create the first school to bring a tenant onto the platform.'}
          </p>
          {!params.q && !params.status ? (
            <p>
              <Link href="/platform/schools/new" className="primary-wide">
                Create a school
              </Link>
            </p>
          ) : null}
        </section>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>School</th>
              <th>Code</th>
              <th>Status</th>
              <th>Contact</th>
              <th>Web address</th>
              <th>Administrator</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {schools.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/platform/schools/${s.id}`}>{s.name}</Link></td>
                <td className="mono">{s.code}</td>
                <td>
                  <span className={STATUS_PILL[s.status] ?? 'pill'}>{s.status}</span>
                </td>
                <td>
                  {s.email || s.phone ? (
                    <>
                      {s.email ? <>{s.email}<br /></> : null}
                      {s.phone ?? ''}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {s.subdomain ? (
                    <span className="mono">{s.subdomain}</span>
                  ) : (
                    <span className="muted">Not set</span>
                  )}
                </td>
                <td>
                  {s.principalName ? (
                    <>
                      {s.principalName}
                      <br />
                      <span className="muted" style={{ fontSize: 12 }}>
                        {s.principalLoginId}
                        {s.principalStatus && s.principalStatus !== 'active'
                          ? ` · account ${s.principalStatus}`
                          : ''}
                      </span>
                    </>
                  ) : (
                    <span className="muted">No principal on record</span>
                  )}
                </td>
                <td className="muted">{s.createdAt.toLocaleDateString('en-GB')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
