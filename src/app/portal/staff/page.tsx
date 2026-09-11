import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { and, asc, eq } from 'drizzle-orm';
import { RegisterStaffForm, AssignStaffForm, StaffRowForm, type StaffRow } from './StaffForms';

export const dynamic = 'force-dynamic';

/**
 * Staff management: register, edit, reset passwords, assign duties, stand down.
 * Checked on the server — hiding the menu item is presentation, not access
 * control; the route (and every service call it makes) refuses on its own.
 */
export default async function StaffPage() {
  const actor = await requireSchoolSession();
  // Teachers may see students (their own classes), but staff management is an
  // office function. Legacy MANAGE_STAFF: principal and vice principal.
  requireRole(actor, ['principal', 'vice_principal']);

  const data = await forSchool(actor.schoolId, async (tx) => {
    const staffRows = await tx.select({
      id: schema.staff.id,
      staffNumber: schema.staff.staffNumber,
      title: schema.staff.title,
      firstName: schema.staff.firstName,
      lastName: schema.staff.lastName,
      gender: schema.staff.gender,
      email: schema.staff.email,
      phone: schema.staff.phone,
      role: schema.staff.role,
      status: schema.staff.status,
      photoUrl: schema.staff.photoUrl,
    }).from(schema.staff)
      .where(eq(schema.staff.schoolId, actor.schoolId))
      .orderBy(asc(schema.staff.lastName))
      .limit(500);

    // Active duties for every staff member, in one pass: what a person holds
    // is the other half of who they are on this screen.
    const dutyRows = await tx.select({
      id: schema.staffAssignments.id,
      staffId: schema.staffAssignments.staffId,
      type: schema.staffAssignments.assignmentType,
      className: schema.classes.displayName,
      subjectName: schema.subjects.name,
    }).from(schema.staffAssignments)
      .leftJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId))
      .leftJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId))
      .where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId),
        eq(schema.staffAssignments.status, 'active'),
      ))
      .orderBy(asc(schema.subjects.name));

    const classes = await tx.select({ id: schema.classes.id, displayName: schema.classes.displayName })
      .from(schema.classes)
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')))
      .orderBy(asc(schema.classes.displayName));

    const subjects = await tx.select({ id: schema.subjects.id, name: schema.subjects.name, code: schema.subjects.code })
      .from(schema.subjects)
      .where(and(eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .orderBy(asc(schema.subjects.name));

    return { staffRows, dutyRows, classes, subjects };
  });

  const dutiesByStaff = new Map<number, StaffRow['duties']>();
  for (const d of data.dutyRows) {
    const list = dutiesByStaff.get(d.staffId) ?? [];
    list.push({
      id: Number(d.id),
      label: d.type === 'class_teacher'
        ? `Class teacher: ${d.className ?? 'unassigned class'}`
        : `${d.subjectName ?? 'subject'} (${d.className ?? 'unassigned class'})`,
    });
    dutiesByStaff.set(d.staffId, list);
  }

  const staff: StaffRow[] = data.staffRows.map((s) => ({
    id: Number(s.id),
    staffNumber: s.staffNumber,
    title: s.title,
    firstName: s.firstName,
    lastName: s.lastName,
    gender: s.gender,
    email: s.email,
    phone: s.phone,
    role: s.role,
    status: s.status,
    photoUrl: s.photoUrl,
    duties: dutiesByStaff.get(Number(s.id)) ?? [],
  }));

  const staffOptions = staff
    .filter((s) => s.status === 'active')
    .map((s) => ({ id: s.id, name: `${s.firstName} ${s.lastName}` }));

  return (
    <>
      <h1 className="page-title">Staff</h1>

      <div className="stack">
        <RegisterStaffForm />

        <AssignStaffForm classes={data.classes} subjects={data.subjects} staffOptions={staffOptions} />

        <div className="card">
          <h2>Staff register ({staff.length})</h2>
          <p className="muted">Class teacher is an assignment a person holds, not a separate role — one class, one class teacher.</p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Staff no.</th><th>Name</th><th>Role</th><th>Duties</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => <StaffRowForm key={s.id} staff={s} classes={data.classes} />)}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
