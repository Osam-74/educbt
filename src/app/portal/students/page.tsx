import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { listStudents, listClasses } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  suspended: 'Suspended',
  withdrawn: 'Withdrawn',
  expelled: 'Expelled',
  pending_approval: 'Pending approval',
  graduated: 'Graduated',
};

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; class?: string }>;
}) {
  const params = await searchParams;
  const actor = await requireSchoolSession();

  const [{ rows, scopeNote }, classes] = await Promise.all([
    listStudents(actor, {
      search: params.q?.trim(),
      status: params.status ?? 'active',
      classId: params.class ? Number(params.class) : undefined,
    }),
    listClasses(actor),
  ]);

  return (
    <>
      <h1 className="page-title">Students</h1>

      {scopeNote ? <p className="note">{scopeNote}</p> : null}

      <form className="filters" method="get">
        <input
          type="search"
          name="q"
          placeholder="Search name or admission number"
          defaultValue={params.q ?? ''}
        />
        <select name="status" defaultValue={params.status ?? 'active'}>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="expelled">Expelled</option>
          <option value="pending_approval">Pending approval</option>
          <option value="all">All</option>
        </select>
        <select name="class" defaultValue={params.class ?? ''}>
          <option value="">All classes</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>{c.displayName}</option>
          ))}
        </select>
        <button type="submit">Apply</button>
      </form>

      <p className="muted">{rows.length} student{rows.length === 1 ? '' : 's'}</p>

      {rows.length === 0 ? (
        <p className="muted">No students match.</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th><th>Admission no.</th><th>Class</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.lastName} {s.firstName}</td>
                <td className="mono">{s.admissionNumber}</td>
                <td>{s.className ?? <span className="muted">Unenrolled</span>}</td>
                <td>
                  <span className={`pill pill--${s.status}`}>
                    {STATUS_LABEL[s.status] ?? s.status}
                  </span>
                </td>
                <td><Link href={`/portal/students/${s.id}`}>View</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
