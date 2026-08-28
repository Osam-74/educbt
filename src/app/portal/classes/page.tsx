import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { listClasses } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function ClassesPage() {
  const actor = await requireSchoolSession();
  const classes = await listClasses(actor);

  return (
    <>
      <h1 className="page-title">Classes</h1>

      {classes.length === 0 ? (
        <p className="muted">
          No classes are assigned to you. The school office manages assignments.
        </p>
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
