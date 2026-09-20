import Link from 'next/link';
import type { teacherDashboard } from '@/lib/teacher-dashboard';

const roleLabel = (role: string) => ({ principal: 'Principal', vice_principal: 'Vice Principal', exam_officer: 'Exam Officer' }[role]);

/**
 * "My Teaching Assignments" — ported from the plugin's teacher/classes.php:
 * Subject Teaching (one card per subject, class/students/Record CA action),
 * General Roles (school-wide role labels plus one row per headed class),
 * and Invigilation Schedule (upcoming duties). This is the Teaching area's
 * own view of "what am I assigned to do", distinct from the Teacher
 * Dashboard's own-work surface and from the office's read-only Classes list.
 */
export default function MyAssignments({ data, role }: {
  data: NonNullable<Awaited<ReturnType<typeof teacherDashboard>>>;
  role: string;
}) {
  const caHref = (classId: number, subjectId: number) =>
    `/portal/ca?pair=${classId}%3A${subjectId}${data.term ? `&termId=${data.term.id}` : ''}`;
  const wideRole = roleLabel(role);
  const hasAnyRole = Boolean(wideRole) || data.headed.length > 0;

  return <>
    <p className="muted" style={{ marginTop: -8, marginBottom: 20 }}>
      {data.session?.title ?? ''} · {data.term?.title ?? 'no current term'}
    </p>

    <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 600, color: '#14532d' }}>Subject Teaching</h2>

    {data.subjects.length === 0 ? (
      <section className="card sa-card" style={{ marginBottom: 24 }}>
        <p className="muted">No subject teaching assignments. The school office assigns these under Staff.</p>
      </section>
    ) : data.subjects.map((s) => (
      <section className="card sa-card" key={s.subjectId} style={{ marginBottom: 20 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 16, fontWeight: 600, color: '#14532d' }}>{s.subjectName}</h3>
        <div className="sa-table-wrap">
          <table className="sa-table">
            <thead><tr><th>Class</th><th>Students</th><th style={{ textAlign: 'right' }}>Action</th></tr></thead>
            <tbody>
              {s.classes.map((c) => (
                <tr key={c.classId}>
                  <td><span className="sa-pill sa-pill--active" style={{ textTransform: 'none' }}>{c.className}</span></td>
                  <td>{c.students} {c.students === 1 ? 'Student' : 'Students'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Link href={caHref(c.classId, s.subjectId)} className="sa-btn sa-btn--primary">Record CA</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    ))}

    <section className="card sa-card" style={{ marginBottom: 24 }}>
      <h2>General Roles</h2>
      {!hasAnyRole ? <p className="muted">No general roles assigned.</p> : <>
        {wideRole && (
          <div style={{ padding: '10px 0', borderBottom: '1px solid #e2e8e4' }}>
            <strong>{wideRole}</strong> &bull; You have school-wide management access.
          </div>
        )}
        {data.headed.map((c) => (
          <div key={c.classId} style={{ padding: '10px 0', borderBottom: '1px solid #e2e8e4' }}>
            <strong>Class Teacher</strong> &bull; {c.className} — {c.students} {c.students === 1 ? 'student' : 'students'}
          </div>
        ))}
      </>}
    </section>

    <section className="card sa-card">
      <h2>Invigilation Schedule</h2>
      {data.duties.length === 0 ? <p className="muted">No invigilation sessions assigned.</p> : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {data.duties.map((d) => (
            <li key={d.paperId} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid #e2e8e4' }}>
              <span>{d.subjectName} — {d.className ?? 'All classes'}</span>
              <span className="muted">
                {d.scheduledAt ? new Date(d.scheduledAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  </>;
}
