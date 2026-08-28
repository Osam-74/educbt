import { requireSchoolSession, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { eq, and, count } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const actor = await requireSchoolSession();

  const stats = await forSchool(actor.schoolId, async (tx) => {
    // School-wide roles see the whole school. A teacher does not — and that is
    // enforced by what we query, not by what we render.
    if (!SCHOOL_WIDE.includes(actor.role as never)) return null;

    const [students] = await tx.select({ n: count() }).from(schema.students)
      .where(and(
        eq(schema.students.schoolId, actor.schoolId),
        eq(schema.students.status, 'active'),
      ));

    const [staff] = await tx.select({ n: count() }).from(schema.staff)
      .where(and(
        eq(schema.staff.schoolId, actor.schoolId),
        eq(schema.staff.status, 'active'),
      ));

    const [subjects] = await tx.select({ n: count() }).from(schema.subjects)
      .where(eq(schema.subjects.schoolId, actor.schoolId));

    const [classes] = await tx.select({ n: count() }).from(schema.classes)
      .where(eq(schema.classes.schoolId, actor.schoolId));

    return {
      students: students?.n ?? 0,
      staff: staff?.n ?? 0,
      subjects: subjects?.n ?? 0,
      classes: classes?.n ?? 0,
    };
  });

  return (
    <>
      <h1 className="page-title">Dashboard</h1>

      {stats ? (
        <div className="stat-grid">
          <div className="stat"><b>{stats.students}</b><span>Students</span></div>
          <div className="stat"><b>{stats.staff}</b><span>Staff</span></div>
          <div className="stat"><b>{stats.classes}</b><span>Classes</span></div>
          <div className="stat"><b>{stats.subjects}</b><span>Subjects</span></div>
        </div>
      ) : (
        <p className="muted">
          Your dashboard is being built. Phase 2 brings class lists, subjects and
          the timetable; the question bank follows in Phase 3.
        </p>
      )}

      <p className="muted" style={{ marginTop: 28 }}>
        Phase 1 — foundation. Tenancy, authentication and the academic structure
        are in place and enforced at the database.
      </p>
    </>
  );
}
