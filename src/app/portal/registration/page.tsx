import Link from 'next/link';
import '../school-table.css';
import { requireSchoolSession } from '@/lib/session';
import { headedClassIds, listClasses } from '@/lib/queries';
import { classRegistrationRoster } from '@/lib/people/students';
import { AutoSubmitSelect } from '../students/StudentForms';
import { RegisterCoreButton } from './RegisterCoreButton';

export const dynamic = 'force-dynamic';

/**
 * Subject Registration — ported from the plugin's teacher/registration.php.
 * A class teacher's two jobs: register the compulsory subjects for the whole
 * class in one action, then open a student to add or remove their electives
 * (that editor already lives on the student profile — this page links there
 * instead of duplicating it, matching how "My students" links to profiles
 * rather than re-building them).
 *
 * Scoped to headedClassIds like /portal/classes and /portal/students'
 * ?scope=mine views: only classes this actor is the CLASS TEACHER of, never
 * every class they merely teach a subject in, and never the whole school's
 * classes even for a wide role reaching this via the Teaching sidebar.
 */
export default async function RegistrationPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string }>;
}) {
  const actor = await requireSchoolSession();
  const params = await searchParams;

  const headed = await headedClassIds(actor);
  const classOptions = headed.length ? await listClasses(actor, { mine: true }) : [];
  const visibleClasses = classOptions.filter((c) => headed.includes(c.id));
  const classId = params.class ? Number(params.class) : visibleClasses[0]?.id;

  const roster = classId ? await classRegistrationRoster(actor, classId) : null;
  const activeClass = visibleClasses.find((c) => c.id === classId);

  return (
    <>
      <h1 className="page-title">Subject Registration</h1>

      {visibleClasses.length === 0 ? (
        <div className="card sa-card">
          <p className="muted">You are not the class teacher for any class, so there is nothing to register here.</p>
        </div>
      ) : (
        <div className="stack">
          <section className="card sa-card">
            <form className="sa-toolbar">
              <AutoSubmitSelect name="class" defaultValue={String(classId ?? '')} aria-label="Choose class">
                {visibleClasses.map((c) => (
                  <option key={c.id} value={c.id}>{c.displayName}</option>
                ))}
              </AutoSubmitSelect>
              <noscript><button type="submit" className="sa-btn">Show</button></noscript>
            </form>
          </section>

          {roster && activeClass && (
            <>
              <section className="card sa-card">
                <h2>Compulsory subjects for {activeClass.displayName}</h2>

                {roster.coreSubjects.length === 0 ? (
                  <p className="sa-note--warn">
                    This school has no compulsory subjects defined. The school office sets these under Subjects.
                  </p>
                ) : (
                  <>
                    <ul style={{ margin: '0 0 4px', paddingLeft: 20 }}>
                      {roster.coreSubjects.map((s) => <li key={s.id}>{s.name}</li>)}
                    </ul>

                    {roster.rows.length > 0 && roster.rows.every((r) => r.registeredCount >= roster.coreCount) ? (
                      <p className="note" style={{ marginTop: 12 }}>
                        ✓ Fully registered — every student in this class already has all {roster.coreCount} compulsory subjects.
                      </p>
                    ) : (
                      <RegisterCoreButton classId={activeClass.id} />
                    )}
                  </>
                )}
              </section>

              <section className="card sa-card">
                <h2>Students <span className="muted">({roster.rows.length})</span></h2>

                {roster.rows.length === 0 ? (
                  <p className="muted">No active students in this class for the current session.</p>
                ) : (
                  <div className="sa-table-wrap">
                    <table className="sa-table">
                      <thead><tr><th>Student</th><th>Admission No.</th><th>Subjects registered</th><th /></tr></thead>
                      <tbody>
                        {roster.rows.map((s) => (
                          <tr key={s.id}>
                            <td>{s.lastName}, {s.firstName}</td>
                            <td><code>{s.admissionNumber}</code></td>
                            <td>
                              {s.registeredCount === 0 ? (
                                <span className="sa-pill sa-pill--draft">none yet</span>
                              ) : s.registeredCount >= roster.coreCount && roster.coreCount > 0 ? (
                                <>{s.registeredCount} <span className="sa-pill sa-pill--active" style={{ marginLeft: 6 }}>✓</span></>
                              ) : (
                                <>{s.registeredCount} <span className="sa-pill sa-pill--pending" style={{ marginLeft: 6 }}>incomplete</span></>
                              )}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <Link className="sa-btn" href={`/portal/students/${s.id}#registration`}>Edit subjects</Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </>
  );
}
