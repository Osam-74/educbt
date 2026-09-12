import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { resultAccess } from '@/lib/results/workflow';

export async function portalCalendar(actor: Actor) {
  return forSchool(actor.schoolId, async tx => {
    const sessions = await tx.select().from(schema.academicSessions).where(and(eq(schema.academicSessions.schoolId, actor.schoolId), eq(schema.academicSessions.isCurrent, true))).limit(2);
    const session = sessions.length === 1 ? sessions[0]! : null;
    const terms = session ? await tx.select().from(schema.terms).where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.sessionId, session.id), eq(schema.terms.isCurrent, true))).limit(2) : [];
    return { session, term: terms.length === 1 ? terms[0]! : null };
  });
}

/**
 * Roles allowed to read the school's audit trail. The legacy capability was
 * VIEW_ACTIVITY_LOG and reached the principal and vice principal; the
 * dashboard has always shown the same roles the trail, so the page and the
 * dashboard panel share this single gate.
 */
export function canViewActivity(actor: Actor) {
  return activityAllowed(actor.role);
}
export function activityAllowed(role: string) {
  return role === 'principal' || role === 'vice_principal';
}

export async function schoolDashboard(actor: Actor) {
  if (!['principal', 'vice_principal', 'exam_officer'].includes(actor.role)) return null;
  const calendar = await portalCalendar(actor);
  return forSchool(actor.schoolId, async tx => {
    await resultAccess(tx, actor);
    const [students] = await tx.select({ n: count() }).from(schema.students).where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'active')));
    const [staff] = await tx.select({ n: count() }).from(schema.staff).where(and(eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active')));
    const [classes] = await tx.select({ n: count() }).from(schema.classes).where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')));
    // A student the office has not approved yet is a real operational item:
    // legacy teacher enrolments waited in this queue (test-people covers the
    // service; here it becomes a number the principal can act on).
    const [pending] = await tx.select({ n: count() }).from(schema.students).where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'pending_approval')));
    const r = schema.subjectResults, e = schema.enrollments, c = schema.classes;
    const pipeline = calendar.session && calendar.term ? await tx.select({ classId: c.id, className: c.displayName, state: r.state, students: sql<number>`count(distinct ${r.studentId})`.mapWith(Number) })
      .from(r).innerJoin(e, and(eq(e.studentId, r.studentId), eq(e.sessionId, r.sessionId), eq(e.schoolId, r.schoolId), eq(e.status, 'active')))
      .innerJoin(c, and(eq(c.id, e.classId), eq(c.schoolId, r.schoolId), eq(c.status, 'active')))
      .where(and(eq(r.schoolId, actor.schoolId), eq(r.sessionId, calendar.session.id), eq(r.termId, calendar.term.id)))
      .groupBy(c.id, c.displayName, r.state).orderBy(asc(c.displayName), asc(r.state)) : [];
    const activity = canViewActivity(actor) ? await tx.select({ id: schema.auditLog.id, action: schema.auditLog.action, createdAt: schema.auditLog.createdAt }).from(schema.auditLog)
      .where(eq(schema.auditLog.schoolId, actor.schoolId)).orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id)).limit(5) : null;
    return { ...calendar, students: students!.n, staff: staff!.n, classes: classes!.n, pendingApprovals: pending!.n, pipeline, activity };
  });
}

/**
 * The full activity log, paginated (legacy school/activity.php). The
 * dashboard keeps its five-event preview; this is the page behind "Activity
 * log" in the nav. School-scoped through forSchool; the role gate mirrors
 * canViewActivity so an exam officer or teacher can never read the trail.
 */
export const ACTIVITY_PER_PAGE = 20;

export async function activityPage(actor: Actor, page: number) {
  if (!canViewActivity(actor)) return null;
  return forSchool(actor.schoolId, async tx => {
    const [totalRow] = await tx.select({ n: count() }).from(schema.auditLog).where(eq(schema.auditLog.schoolId, actor.schoolId));
    const total = totalRow!.n;
    const pages = Math.max(1, Math.ceil(total / ACTIVITY_PER_PAGE));
    const safePage = Math.min(Math.max(1, page), pages);
    const rows = await tx.select({
      id: schema.auditLog.id,
      action: schema.auditLog.action,
      actorRole: schema.auditLog.actorRole,
      entityType: schema.auditLog.entityType,
      createdAt: schema.auditLog.createdAt,
    })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.schoolId, actor.schoolId))
      .orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id))
      .limit(ACTIVITY_PER_PAGE)
      .offset((safePage - 1) * ACTIVITY_PER_PAGE);
    return { rows, total, pages, page: safePage };
  });
}

export function activityTitle(action: string) {
  const titles: Record<string, string> = { 'results.compiled': 'Compiled class results', 'results.reviewed': 'Reviewed class results', 'results.published': 'Published results to families', 'results.locked': 'Locked published results', 'results.transitioned': 'Updated the results stage', 'question.approved': 'Approved questions', 'school.created': 'Created the school', 'ca.score_entered': 'Recorded an assessment score' };
  return titles[action] ?? 'School record updated';
}
