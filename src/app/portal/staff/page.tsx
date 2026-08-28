import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { listStaff } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  principal: 'Principal',
  vice_principal: 'Vice Principal',
  exam_officer: 'Examination Officer',
  teacher: 'Teacher',
};

export default async function StaffPage() {
  const actor = await requireSchoolSession();

  // Checked on the server. Hiding the menu item is presentation, not access
  // control — the route must refuse on its own.
  requireRole(actor, SCHOOL_WIDE);

  const staff = await listStaff(actor);

  return (
    <>
      <h1 className="page-title">Staff</h1>
      <table className="tbl">
        <thead>
          <tr><th>Name</th><th>Staff no.</th><th>Role</th><th>Email</th><th>Status</th></tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id}>
              <td>{s.lastName} {s.firstName}</td>
              <td className="mono">{s.staffNumber}</td>
              <td>{ROLE_LABEL[s.role] ?? s.role}</td>
              <td>{s.email ?? <span className="muted">—</span>}</td>
              <td><span className={`pill pill--${s.status}`}>{s.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
