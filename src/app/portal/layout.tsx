import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { eq } from 'drizzle-orm';
import PortalShell from './PortalShell';
import './portal-shell.css';
import { portalCalendar } from '@/lib/portal-dashboard';
import { and } from 'drizzle-orm';
import { signOut } from '@/lib/auth';

/**
 * Every portal page shows per-user data, so none of them may be cached.
 *
 * A cached page served to the wrong student was the single worst failure in the
 * WordPress system. Setting this at the LAYOUT means it applies to every route
 * beneath it, and a new page cannot forget it.
 */
export const dynamic = 'force-dynamic';

const ROLE_LABEL: Record<string, string> = {
  principal: 'Principal',
  vice_principal: 'Vice Principal',
  exam_officer: 'Examination Officer',
  teacher: 'Teacher',
  student: 'Student',
  parent: 'Parent',
};

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireSchoolSession();

  // The school comes from the SESSION tenant, and the query runs inside
  // forSchool — so even this read is bounded by Row-Level Security.
  const { school, displayName } = await forSchool(actor.schoolId, async (tx) => {
    const [s] = await tx.select({ name: schema.schools.name })
      .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);

    // Prefer the school's own record of the person's name over anything stored
    // on the login account, which goes stale the moment the office edits it.
    let name = actor.loginId;

    if (actor.staffId) {
      const [st] = await tx.select({ f: schema.staff.firstName, l: schema.staff.lastName })
        .from(schema.staff).where(eq(schema.staff.id, actor.staffId)).limit(1);
      if (st) name = `${st.f} ${st.l}`;
    } else if (actor.studentId) {
      const [sd] = await tx.select({ f: schema.students.firstName, l: schema.students.lastName })
        .from(schema.students).where(eq(schema.students.id, actor.studentId)).limit(1);
      if (sd) name = `${sd.f} ${sd.l}`;
    }

    return { school: s, displayName: name };
  });

  async function endSession() {
    'use server';
    await signOut({ redirectTo: '/sign-in' });
  }

  const calendar = await portalCalendar(actor);
  const assignments = actor.staffId ? await forSchool(actor.schoolId, tx => tx.select({ type: schema.staffAssignments.assignmentType }).from(schema.staffAssignments).where(and(eq(schema.staffAssignments.staffId, actor.staffId!), eq(schema.staffAssignments.status, 'active')))) : [];
  return <PortalShell school={school?.name ?? 'School'} displayName={displayName} role={actor.role}
    calendar={`${calendar.session?.title ?? 'No current session'} · ${calendar.term?.title ?? 'No current term'}`}
    teaching={assignments.length > 0} classTeacher={assignments.some(a => a.type === 'class_teacher')} signOut={endSession}>{children}</PortalShell>;
}
