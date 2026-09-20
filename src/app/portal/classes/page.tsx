import Link from 'next/link';
import '../school-table.css';
import { requireSchoolSession } from '@/lib/session';
import { listClasses } from '@/lib/queries';
import { classesView } from '@/lib/school/classes';
import { teacherDashboard } from '@/lib/teacher-dashboard';
import { CreateClassesCard, ClassesTable } from './ClassesClient';
import MyAssignments from './MyAssignments';

export const dynamic = 'force-dynamic';

/**
 * Classes — ported from the plugin's school/classes.php. The office (MANAGE_
 * CLASSES: principal and vice principal) creates every arm of a level at once,
 * edits arm / capacity / department inline, and archives a class only once it
 * is empty of students and papers. Teachers and exam officers keep the legacy
 * teacher view: the classes they hold, read-only.
 *
 * A principal/VP/exam officer who ALSO holds a teaching assignment gets a
 * "Teaching" sidebar area whose "My assignments" link points at this same
 * route with ?scope=mine — that forces the teacher-owned view below even
 * though the role itself would otherwise take the office branch.
 */
export default async function ClassesPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const actor = await requireSchoolSession();
  const mine = (await searchParams).scope === 'mine';

  if (!['principal', 'vice_principal'].includes(actor.role) || mine) {
    // A staff account (teacher, exam officer, or a wide role reaching this
    // via ?scope=mine) gets the legacy teacher/classes.php experience: My
    // Teaching Assignments, not the office's plain read-only class list.
    // teacherDashboard already resolves every piece this view needs (its
    // own forSchool read is cheap — the SAME query set '/portal' uses for
    // the Teacher Dashboard) and returns null for anyone without a staffId.
    const teaching = actor.staffId ? await teacherDashboard(actor, { mine: true }) : null;
    if (teaching) {
      return (
        <>
          <h1 className="page-title">My Teaching Assignments</h1>
          <MyAssignments data={teaching} role={actor.role} />
        </>
      );
    }

    const classes = await listClasses(actor, { mine });

    return (
      <>
        <h1 className="page-title">Classes</h1>

        {classes.length === 0 ? (
          <p className="muted">No classes are assigned to you. The school office manages assignments.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Class</th><th>Level</th><th>Department</th><th>Students</th><th /></tr>
            </thead>
            <tbody>
              {classes.map((c) => (
                <tr key={c.id}>
                  <td>{c.displayName}</td>
                  <td>{c.levelName}</td>
                  <td>{c.departmentName ?? <span className="muted">—</span>}</td>
                  <td>{c.headcount}</td>
                  <td><Link href={`/portal/students?class=${c.id}`}>Register</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }

  const view = await classesView(actor);

  return (
    <>
      <h1 className="page-title">Classes</h1>

      {view.levels.length === 0 && (
        <div className="card sa-card">
          <p className="error">
            No class levels exist yet, so classes cannot be created. The school&apos;s levels
            (JSS 1, SS 1…) are part of its academic structure.
          </p>
        </div>
      )}

      <CreateClassesCard levels={view.levels} departments={view.departments} />

      <ClassesTable rows={view.rows} departments={view.departments} />
    </>
  );
}
