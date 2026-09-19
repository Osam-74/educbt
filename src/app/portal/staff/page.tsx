import '../school-table.css';
import { requireSchoolSession, requireRole } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { and, asc, eq } from 'drizzle-orm';
import { RegisterStaffForm, AssignDutiesForm, StaffRowForm, type StaffRow } from './StaffForms';
import * as staffLib from '@/lib/people/staff';

export const dynamic = 'force-dynamic';

/**
 * Staff management: register, edit, reset passwords, assign duties, stand down.
 * Checked on the server — hiding the menu item is presentation, not access
 * control; the route (and every service call it makes) refuses on its own.
 *
 * Page structure follows the legacy plugin (templates/portal/school/staff.php):
 * add card, assignment builder, then the register table — grouped by class
 * LEVEL, because a subject teacher covers the year group, not one arm.
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
      email: schema.staff.email,
      phone: schema.staff.phone,
      role: schema.staff.role,
      status: schema.staff.status,
      photoUrl: schema.staff.photoUrl,
    }).from(schema.staff)
      .where(eq(schema.staff.schoolId, actor.schoolId))
      .orderBy(asc(schema.staff.lastName))
      .limit(500);

    // Active duties per person, joined to their LEVEL so "Mathematics — JS1,
    // JS2" reads as one duty — the plugin's $holdings grouping.
    const dutyRows = await tx.select({
      id: schema.staffAssignments.id,
      staffId: schema.staffAssignments.staffId,
      type: schema.staffAssignments.assignmentType,
      levelName: schema.classLevels.name,
      levelId: schema.classes.levelId,
      subjectName: schema.subjects.name,
      subjectId: schema.subjects.id,
    }).from(schema.staffAssignments)
      .leftJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId))
      .leftJoin(schema.classLevels, eq(schema.classLevels.id, schema.classes.levelId))
      .leftJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId))
      .where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId),
        eq(schema.staffAssignments.status, 'active'),
      ))
      .orderBy(asc(schema.subjects.name));

    // Levels for the assignment builder: each expands to its arms' class ids.
    const levelRows = await tx.select({
      id: schema.classLevels.id,
      name: schema.classLevels.name,
      stage: schema.classLevels.stage,
      levelOrder: schema.classLevels.levelOrder,
    }).from(schema.classLevels)
      .where(eq(schema.classLevels.schoolId, actor.schoolId))
      .orderBy(asc(schema.classLevels.levelOrder));

    const classRows = await tx.select({ id: schema.classes.id, levelId: schema.classes.levelId })
      .from(schema.classes)
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')));

    const subjects = await tx.select({
      id: schema.subjects.id,
      name: schema.subjects.name,
      code: schema.subjects.code,
      stage: schema.subjects.stage,
    }).from(schema.subjects)
      .where(and(eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .orderBy(asc(schema.subjects.name));

    // The builder only makes sense inside a session (plugin: $session_id > 0).
    const [session] = await tx.select({ id: schema.academicSessions.id })
      .from(schema.academicSessions)
      .where(and(eq(schema.academicSessions.schoolId, actor.schoolId), eq(schema.academicSessions.isCurrent, true)))
      .limit(1);

    return { staffRows, dutyRows, levelRows, classRows, subjects, hasSession: Boolean(session) };
  });

  // Group holdings exactly as the plugin does: class-teacher levels deduped,
  // subjects grouped with their level lists, ids kept for the Drop buttons.
  const byStaff = new Map<number, {
    classTeacher: Map<string, { levelId: number | null; ids: number[] }>;
    subjects: Map<string, { subjectId: number | null; levels: Map<string, number[]> }>;
  }>();
  for (const d of data.dutyRows) {
    const entry = byStaff.get(d.staffId) ?? { classTeacher: new Map(), subjects: new Map() };
    const levelName = d.levelName ?? 'unassigned level';
    if (d.type === 'class_teacher') {
      const group = entry.classTeacher.get(levelName) ?? { levelId: d.levelId, ids: [] };
      group.ids.push(Number(d.id));
      entry.classTeacher.set(levelName, group);
    } else {
      const subjectName = d.subjectName ?? 'subject';
      const subject = entry.subjects.get(subjectName) ?? { subjectId: d.subjectId, levels: new Map<string, number[]>() };
      const ids = subject.levels.get(levelName) ?? [];
      ids.push(Number(d.id));
      subject.levels.set(levelName, ids);
      entry.subjects.set(subjectName, subject);
    }
    byStaff.set(d.staffId, entry);
  }

  // Level names read in school order (JSS 1 before JSS 2) inside each duty.
  const levelOrder = new Map(data.levelRows.map((l) => [l.name, l.levelOrder]));

  const staff: StaffRow[] = data.staffRows.map((s) => {
    const held = byStaff.get(Number(s.id));
    return {
      id: Number(s.id),
      staffNumber: s.staffNumber,
      title: s.title,
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
      phone: s.phone,
      role: s.role,
      status: s.status,
      photoUrl: s.photoUrl,
      classTeacherLevels: held
        ? [...held.classTeacher.entries()].map(([level, g]) => ({ level, assignmentIds: g.ids }))
        : [],
      subjects: held
        ? [...held.subjects.entries()].map(([subject, g]) => ({
          subject,
          levels: [...g.levels.keys()].sort((a, b) => (levelOrder.get(a) ?? 0) - (levelOrder.get(b) ?? 0)),
          assignmentIds: [...g.levels.values()].flat(),
        }))
        : [],
    };
  });

  const levels = data.levelRows.map((l) => ({
    id: Number(l.id),
    name: l.name,
    stage: l.stage,
    armCount: data.classRows.filter((c) => c.levelId === l.id).length,
    classIds: data.classRows.filter((c) => c.levelId === l.id).map((c) => Number(c.id)),
  }));

  // Pre-fill data for the builder: what each active teacher already holds
  // (plugin's educbtExistingAssignments), computed by the same pure function
  // the unit test in lib/people/staff-prefill.test.ts pins down — see
  // buildAssignmentPrefill's own comment for the rule it enforces.
  const activeStaffIds = staff.filter((s) => s.status === 'active' && byStaff.has(s.id)).map((s) => s.id);
  const existing = staffLib.buildAssignmentPrefill(
    data.dutyRows.map((d) => ({
      staffId: Number(d.staffId), type: d.type,
      levelId: d.levelId == null ? null : Number(d.levelId),
      subjectId: d.subjectId == null ? null : Number(d.subjectId),
    })),
    activeStaffIds,
  );

  const staffOptions = staff
    .filter((s) => s.status === 'active')
    .map((s) => ({ id: s.id, name: `${s.title ? `${s.title} ` : ''}${s.firstName} ${s.lastName}` }));

  return (
    <>
      <h1 className="page-title">Staff</h1>

      <div className="stack">
        <RegisterStaffForm />

        {staffOptions.length > 0 && data.hasSession && (
          <AssignDutiesForm
            staffOptions={staffOptions}
            levels={levels}
            subjects={data.subjects.map((s) => ({ id: Number(s.id), name: s.name, code: s.code, stage: s.stage }))}
            existing={existing}
          />
        )}

        <div className="card sa-card">
          <h2>Staff <span className="muted">({staff.length})</span></h2>
          {staff.length === 0
            ? <p className="muted">No staff added yet.</p>
            : (
              <div className="sa-table-wrap">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th>Staff no.</th><th>Name</th><th>Role</th><th>Assignments</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((s) => <StaffRowForm key={s.id} staff={s} />)}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      </div>
    </>
  );
}
