import Link from 'next/link';
import '../school-table.css';
import { requireSchoolSession } from '@/lib/session';
import { isSchoolWide, listStudents, listClasses, pendingApprovalCount, headedClassIds, myStudents } from '@/lib/queries';
import ArmPanel from './ArmPanel';
import { armSources, armTargets, armRoster } from '@/lib/people/arm-assignment';
import { RegisterStudentForm, ImportStudentsForm, StudentRowForm, AutoSubmitSelect } from './StudentForms';

export const dynamic = 'force-dynamic';


/** What the arm panel needs: the classes that can be split, where each can go, and who is in each. Same scope as the move. */
async function armPanelData(actor: Awaited<ReturnType<typeof requireSchoolSession>>) {
  const sources = await armSources(actor);
  const targetsByClass: Record<number, Array<{ id: number; name: string }>> = {};
  const rosterByClass: Record<number, Awaited<ReturnType<typeof armRoster>>> = {};
  for (const c of sources) {
    targetsByClass[c.id] = (await armTargets(actor, c.id)).map((t) => ({ id: t.id, name: t.name }));
    rosterByClass[c.id] = await armRoster(actor, c.id);
  }
  return { sources, targetsByClass, rosterByClass };
}

function ArmOutcome({ ok, error, skipped }: { ok?: string; error?: string; skipped?: string }) {
  let rows: Array<{ n: string; r: string }> = [];
  try { rows = skipped ? JSON.parse(skipped) : []; } catch { rows = []; }
  if (!ok && !error) return null;
  return (
    <section className="card sa-card" role="status" data-testid="arm-outcome" style={{ borderLeft: `4px solid ${error ? '#b3261e' : '#1f7a3d'}` }}>
      <strong>{error ?? ok}</strong>
      {rows.length ? (
        <>
          <p className="muted" style={{ margin: '8px 0 4px' }}>{rows.length} not moved:</p>
          <ul data-testid="arm-skipped" style={{ margin: 0, paddingLeft: 18 }}>{rows.map((x, i) => <li key={i}><strong>{x.n}</strong>: {x.r}</li>)}</ul>
        </>
      ) : null}
    </section>
  );
}

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; class?: string; scope?: string; armOk?: string; armError?: string; armSkipped?: string }>;
}) {
  const params = await searchParams;
  const actor = await requireSchoolSession();
  const status = params.status ?? 'active';
  // A principal/VP/exam officer who also teaches reaches this same route via
  // the "Teaching" area's "My students" link (?scope=mine) — force the
  // teacher-owned view even though the role would otherwise take the office
  // branch, matching the same fix applied to /portal/classes.
  const mine = params.scope === 'mine';

  // "My students" (Teaching area, ?scope=mine) is a DIFFERENT page from the
  // School area's Students list, not the same list re-scoped — legacy
  // templates/portal/teacher/students.php is a plain read-only roster for
  // the classes this actor heads as CLASS TEACHER specifically (not every
  // class they merely teach a subject in), with no search/status filter and
  // no enrol form (the legacy plugin never wires a form to that capability
  // from this page either). Handle it as its own render, before the shared
  // office layout below.
  if (mine) {
    const headed = await headedClassIds(actor);
    const classId = params.class ? Number(params.class) : headed[0];
    const classOptions = headed.length
      ? await listClasses(actor, { mine: true })
      : [];
    const visibleClasses = classOptions.filter((c) => headed.includes(c.id));
    const roster = classId ? await myStudents(actor, classId) : [];

    return (
      <>
        <h1 className="page-title">My Students</h1>

        <div className="stack">
          <section className="card sa-card">
            {visibleClasses.length === 0 ? (
              <p className="sa-empty">You are not the class teacher of any class. The school office assigns class teacher roles under Staff.</p>
            ) : (
              <form className="sa-toolbar" method="get">
                <input type="hidden" name="scope" value="mine" />
                <AutoSubmitSelect name="class" defaultValue={String(classId ?? '')} aria-label="Choose class">
                  {visibleClasses.map((c) => (
                    <option key={c.id} value={c.id}>{c.displayName}</option>
                  ))}
                </AutoSubmitSelect>
                <noscript><button type="submit" className="sa-btn">Show</button></noscript>
              </form>
            )}
          </section>

          <ArmOutcome ok={params.armOk} error={params.armError} skipped={params.armSkipped} />
          <ArmPanel {...(await armPanelData(actor))} selectedClass={classId ?? 0} returnParams="scope=mine" />

          {visibleClasses.length > 0 && (
            <section className="card sa-card">
              <h2>Students <span className="muted">({roster.length})</span></h2>

              {roster.length === 0 ? (
                <p className="sa-empty">No active students in this class for the current session.</p>
              ) : (
                <div className="sa-table-wrap">
                  <table className="sa-table">
                    <thead>
                      <tr>
                        <th>#</th><th>Name</th><th>Admission No.</th><th>Parent / Guardian</th><th>Phone</th><th>Status</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {roster.map((s, i) => (
                        <tr key={s.id}>
                          <td>{i + 1}</td>
                          <td><Link href={`/portal/students/${s.id}`}>{s.lastName}, {s.firstName}</Link></td>
                          <td>{s.admissionNumber}</td>
                          <td>{s.parentName || '—'}</td>
                          <td>{s.parentPhone || '—'}</td>
                          <td><span className={`sa-pill sa-pill--${s.status}`}>{s.status === 'pending_approval' ? 'Pending Approval' : s.status}</span></td>
                          <td><Link className="sa-btn" href={`/portal/students/${s.id}`}>View profile</Link></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
      </>
    );
  }

  const [{ rows, scopeNote }, classes, pendingCount] = await Promise.all([
    listStudents(actor, {
      search: params.q?.trim(),
      status,
      classId: params.class ? Number(params.class) : undefined,
    }),
    listClasses(actor),
    pendingApprovalCount(actor),
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

        <ArmOutcome ok={params.armOk} error={params.armError} skipped={params.armSkipped} />
        {office ? <ArmPanel {...(await armPanelData(actor))} selectedClass={params.class ? Number(params.class) : 0} returnParams={new URLSearchParams(Object.entries({ q: params.q ?? '', status: params.status ?? '', class: params.class ?? '' }).filter(([, v]) => v)).toString()} /> : null}

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
