import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
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

  return (
    <div className="portal">
      <header className="portal__bar">
        <div>
          <strong>{school?.name ?? 'School'}</strong>
          <span className="portal__who">
            {displayName} · {ROLE_LABEL[actor.role] ?? actor.role}
          </span>
        </div>
        <nav>
          <Link href="/portal">Dashboard</Link>
          <Link href="/portal/students">Students</Link>
          <Link href="/portal/classes">Classes</Link>
          <Link href="/portal/subjects">Subjects</Link>
          <Link href="/portal/questions">Questions</Link>
          <Link href="/portal/marking">Marking</Link>
          {/* Menu visibility is convenience only. /portal/staff refuses on the
              server for anyone who is not school-wide, so removing this link is
              not what protects it. */}
          {['principal', 'vice_principal', 'exam_officer'].includes(actor.role) ? (
            <>
              <Link href="/portal/exams">Exam office</Link>
              <Link href="/portal/review">Review</Link>
              <Link href="/portal/broadsheet">Broadsheet</Link>
              <Link href="/portal/staff">Staff</Link>
            </>
          ) : null}
          <Link href="/portal/account/password">Password</Link>
          <form action={endSession} style={{ display: 'inline' }}>
            <button type="submit" className="linkish">Sign out</button>
          </form>
        </nav>
      </header>
      <main className="portal__body">{children}</main>
    </div>
  );
}
