import { requireSchoolSession } from '@/lib/session';
import { listSubjects } from '@/lib/queries';

export const dynamic = 'force-dynamic';

export default async function SubjectsPage() {
  const actor = await requireSchoolSession();
  const subjects = await listSubjects(actor);

  const junior = subjects.filter((s) => s.stage === 'junior');
  const senior = subjects.filter((s) => s.stage === 'senior');
  const both = subjects.filter((s) => s.stage === 'both');

  const table = (rows: typeof subjects) => (
    <table className="tbl">
      <thead>
        <tr><th>Subject</th><th>Code</th><th>Department</th><th>Compulsory</th></tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={s.id}>
            <td>{s.name}</td>
            {/* The code is what separates junior Mathematics (MTH-J) from
                senior General Mathematics (MTH). Without it these are two
                identical rows. */}
            <td className="mono">{s.code}</td>
            <td>{s.departmentName ?? <span className="muted">All</span>}</td>
            <td>{s.isCompulsory ? 'Yes' : <span className="muted">No</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      <h1 className="page-title">Subjects</h1>
      {junior.length > 0 && <><h2 className="sub-head">Junior</h2>{table(junior)}</>}
      {senior.length > 0 && <><h2 className="sub-head">Senior</h2>{table(senior)}</>}
      {both.length > 0 && <><h2 className="sub-head">All levels</h2>{table(both)}</>}
    </>
  );
}
