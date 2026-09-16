import '../school-table.css';
import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { isSchoolWide } from '@/lib/queries';
import { listStudents, listClasses } from '@/lib/queries';
import { RegisterStudentForm, StudentRowActions } from './StudentForms';

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

  // Teachers enrol into their own classes only, and the record waits for the
  // office's approval (legacy teacher_add_student). The service enforces it;
  // the flag here only changes the form's wording.
  const office = isSchoolWide(actor.role);

  return (
    <>
      <h1 className="page-title">Students</h1>

      {scopeNote ? <p className="note">{scopeNote}</p> : null}

      <div className="stack">
        {classes.length > 0 && <RegisterStudentForm classes={classes} teacher={!office} />}

        <section className="card sa-card">
          <h2>Enrolled students <span className="muted">({rows.length})</span></h2>

          <form className="sa-toolbar" method="get">
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
            <button type="submit" className="sa-btn sa-btn--small sa-btn--primary">Search</button>
            {params.q && <a className="sa-btn sa-btn--small" href="/portal/students">Clear</a>}
            <noscript><button type="submit" className="sa-btn sa-btn--small">Apply</button></noscript>
          </form>

          {rows.length === 0 ? (
            <p className="sa-empty">No students match.</p>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Admission no.</th><th>Student</th><th>Class</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.admissionNumber}</td>
                      <td>{s.lastName} {s.firstName}</td>
                      <td>{s.className ?? <span className="muted">Unenrolled</span>}</td>
                      <td>
                        <span className={`sa-pill sa-pill--${s.status}`}>
                          {STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      </td>
                      <td className="row-actions">
                        <Link href={`/portal/students/${s.id}`} className="sa-btn sa-btn--small sa-btn--primary">View</Link>
                        <StudentRowActions studentId={s.id} status={s.status} office={office} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
