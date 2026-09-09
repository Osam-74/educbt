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
export async function schoolDashboard(actor: Actor) {
  if (!['principal', 'vice_principal', 'exam_officer'].includes(actor.role)) return null;
  const calendar = await portalCalendar(actor);
  return forSchool(actor.schoolId, async tx => {
    await resultAccess(tx, actor);
    const [students] = await tx.select({ n: count() }).from(schema.students).where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'active')));
    const [staff] = await tx.select({ n: count() }).from(schema.staff).where(and(eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active')));
    const [classes] = await tx.select({ n: count() }).from(schema.classes).where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')));
    const r = schema.subjectResults, e = schema.enrollments, c = schema.classes;
    const pipeline = calendar.session && calendar.term ? await tx.select({ classId: c.id, className: c.displayName, state: r.state, students: sql<number>`count(distinct ${r.studentId})`.mapWith(Number) })
      .from(r).innerJoin(e, and(eq(e.studentId, r.studentId), eq(e.sessionId, r.sessionId), eq(e.schoolId, r.schoolId), eq(e.status, 'active')))
      .innerJoin(c, and(eq(c.id, e.classId), eq(c.schoolId, r.schoolId), eq(c.status, 'active')))
      .where(and(eq(r.schoolId, actor.schoolId), eq(r.sessionId, calendar.session.id), eq(r.termId, calendar.term.id)))
      .groupBy(c.id, c.displayName, r.state).orderBy(asc(c.displayName), asc(r.state)) : [];
    const activity = ['principal', 'vice_principal'].includes(actor.role) ? await tx.select({ id: schema.auditLog.id, action: schema.auditLog.action, createdAt: schema.auditLog.createdAt }).from(schema.auditLog)
      .where(eq(schema.auditLog.schoolId, actor.schoolId)).orderBy(desc(schema.auditLog.createdAt), desc(schema.auditLog.id)).limit(5) : null;
    return { ...calendar, students: students!.n, staff: staff!.n, classes: classes!.n, pipeline, activity };
  });
}
export function activityTitle(action: string) {
  const titles: Record<string, string> = { 'results.compiled': 'Compiled class results', 'results.reviewed': 'Reviewed class results', 'results.published': 'Published results to families', 'results.locked': 'Locked published results', 'results.transitioned': 'Updated the results stage', 'question.approved': 'Approved questions', 'school.created': 'Created the school', 'ca.score_entered': 'Recorded an assessment score' };
  return titles[action] ?? 'School record updated';
}
