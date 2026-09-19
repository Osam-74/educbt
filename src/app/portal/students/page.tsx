import '../school-table.css';
import { requireSchoolSession } from '@/lib/session';
import { isSchoolWide, listStudents, listClasses, pendingApprovalCount } from '@/lib/queries';
import { RegisterStudentForm, ImportStudentsForm, StudentRowForm, AutoSubmitSelect } from './StudentForms';

export const dynamic = 'force-dynamic';

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; class?: string; scope?: string }>;
}) {
  const params = await searchParams;
  const actor = await requireSchoolSession();
  const status = params.status ?? 'active';
  // A principal/VP/exam officer who also teaches reaches this same route via
  // the "Teaching" area's "My students" link (?scope=mine) — force the
  // teacher-owned view even though the role would otherwise take the office
  // branch, matching the same fix applied to /portal/classes.
  const mine = params.scope === 'mine';

  const [{ rows, scopeNote }, classes, pendingCount] = await Promise.all([
    listStudents(actor, {
      search: params.q?.trim(),
      status,
      classId: params.class ? Number(params.class) : undefined,
      mine,
    }),
    listClasses(actor, { mine }),
    pendingApprovalCount(actor),
  ]);

  // Teachers enrol into their own classes only, and the record waits for the
  // office's approval (legacy teacher_add_student). The service enforces it;
  // the flag here only changes the form's wording.
  const office = isSchoolWide(actor.role) && !mine;

  return (
    <>
      <h1 className="page-title">Students</h1>

      {scopeNote ? <p className="note">{scopeNote}</p> : null}

      <div className="stack">
        {office && pendingCount > 0 && status !== 'pending_approval' && (
          <section className="card sa-card" style={{ borderLeft: '4px solid #E2A33B', background: '#FFF8E8' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <strong>{pendingCount} student{pendingCount === 1 ? '' : 's'} pending approval</strong>
                <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
                  A teacher added these students. Review and approve them to activate their enrolment.
                </p>
              </div>
              <a className="sa-btn sa-btn--primary" href="/portal/students?status=pending_approval">Review pending</a>
            </div>
          </section>
        )}

        <section className="card sa-card">
          <h2>Enrolled students <span className="muted">({rows.length})</span></h2>

          <form className="sa-toolbar" method="get">
            <input
              type="search"
              name="q"
              placeholder="Search name or student ID"
              defaultValue={params.q ?? ''}
            />
            <AutoSubmitSelect name="class" defaultValue={params.class ?? ''} aria-label="Filter by class">
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName}</option>
              ))}
            </AutoSubmitSelect>
            <AutoSubmitSelect name="status" defaultValue={status} aria-label="Filter by status">
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="expelled">Expelled</option>
              <option value="all">All</option>
            </AutoSubmitSelect>
            <button type="submit" className="sa-btn sa-btn--primary">Search</button>
            {params.q && <a className="sa-btn" href="/portal/students">Clear</a>}
            <noscript><button type="submit" className="sa-btn">Filter</button></noscript>
          </form>

          {rows.length === 0 ? (
            <p className="sa-empty">No students enrolled yet.</p>
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
                    <StudentRowForm key={s.id} student={s} classes={classes} office={office} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {classes.length > 0 && (
          <details className="sa-details">
            <summary><h2>Register a student</h2></summary>
            <RegisterStudentForm classes={classes} teacher={!office} />
          </details>
        )}

        {office && classes.length > 0 && (
          <details className="sa-details">
            <summary><h2>Import many students</h2></summary>
            <ImportStudentsForm classes={classes} />
          </details>
        )}
      </div>
    </>
  );
}
