import { and, eq, asc } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { isEditable } from '@/domain/academic';
import { caAssignment, caSchool, canEnterCa } from './access';
import { caComponents, caScopeSchema, type CaScope } from './validation';

export async function caOptions(actor: Actor) {
  if (!canEnterCa(actor)) return null;
  return forSchool(actor.schoolId, async tx => {
    const school = await caSchool(tx, actor);
    if (!school) return null;
    const sessions = await tx.select({ id: schema.academicSessions.id, title: schema.academicSessions.title })
      .from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, actor.schoolId))
      .orderBy(asc(schema.academicSessions.title));
    const terms = await tx.select({ id: schema.terms.id, sessionId: schema.terms.sessionId, title: schema.terms.title })
      .from(schema.terms).where(eq(schema.terms.schoolId, actor.schoolId)).orderBy(asc(schema.terms.position));
    const pairs = await tx.select({
      classId: schema.classes.id, className: schema.classes.displayName,
      subjectId: schema.subjects.id, subjectName: schema.subjects.name, subjectCode: schema.subjects.code,
    }).from(schema.classes).innerJoin(schema.subjects, eq(schema.subjects.schoolId, actor.schoolId))
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active'),
        eq(schema.subjects.status, 'active'), caAssignment(tx, actor, schema.classes.id, schema.subjects.id)))
      .orderBy(asc(schema.classes.displayName), asc(schema.subjects.name));
    return { sessions, terms, pairs, components: caComponents(school.settings) };
  });
}

export async function caRoster(actor: Actor, scope: CaScope) {
  if (!canEnterCa(actor) || !caScopeSchema.safeParse(scope).success) return null;
  return forSchool(actor.schoolId, async tx => {
    const school = await caSchool(tx, actor);
    const component = school && caComponents(school.settings).find(c => c.key === scope.componentKey);
    if (!component) return null;
    const [context] = await tx.select({
      className: schema.classes.displayName, subjectName: schema.subjects.name,
      sessionTitle: schema.academicSessions.title, termTitle: schema.terms.title,
    }).from(schema.classes)
      .innerJoin(schema.subjects, and(eq(schema.subjects.id, scope.subjectId), eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .innerJoin(schema.academicSessions, and(eq(schema.academicSessions.id, scope.sessionId), eq(schema.academicSessions.schoolId, actor.schoolId)))
      .innerJoin(schema.terms, and(eq(schema.terms.id, scope.termId), eq(schema.terms.sessionId, scope.sessionId), eq(schema.terms.schoolId, actor.schoolId)))
      .where(and(eq(schema.classes.id, scope.classId), eq(schema.classes.schoolId, actor.schoolId),
        eq(schema.classes.status, 'active'), caAssignment(tx, actor, scope.classId, scope.subjectId))).limit(1);
    if (!context) return null;
    const rows = await tx.select({
      studentId: schema.students.id, firstName: schema.students.firstName, lastName: schema.students.lastName,
      admissionNumber: schema.students.admissionNumber, score: schema.assessmentScores.score,
      updatedAt: schema.assessmentScores.updatedAt, state: schema.subjectResults.state,
      published: schema.subjectResults.published,
    }).from(schema.students)
      .innerJoin(schema.enrollments, and(eq(schema.enrollments.studentId, schema.students.id),
        eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.classId, scope.classId),
        eq(schema.enrollments.sessionId, scope.sessionId), eq(schema.enrollments.status, 'active')))
      .innerJoin(schema.studentSubjects, and(eq(schema.studentSubjects.studentId, schema.students.id),
        eq(schema.studentSubjects.schoolId, actor.schoolId), eq(schema.studentSubjects.subjectId, scope.subjectId),
        eq(schema.studentSubjects.sessionId, scope.sessionId)))
      .leftJoin(schema.assessmentScores, and(eq(schema.assessmentScores.schoolId, actor.schoolId),
        eq(schema.assessmentScores.studentId, schema.students.id), eq(schema.assessmentScores.subjectId, scope.subjectId),
        eq(schema.assessmentScores.sessionId, scope.sessionId), eq(schema.assessmentScores.termId, scope.termId),
        eq(schema.assessmentScores.componentKey, scope.componentKey)))
      .leftJoin(schema.subjectResults, and(eq(schema.subjectResults.schoolId, actor.schoolId),
        eq(schema.subjectResults.studentId, schema.students.id), eq(schema.subjectResults.subjectId, scope.subjectId),
        eq(schema.subjectResults.sessionId, scope.sessionId), eq(schema.subjectResults.termId, scope.termId)))
      .where(and(eq(schema.students.schoolId, actor.schoolId), eq(schema.students.status, 'active')))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName), asc(schema.students.admissionNumber));
    return { ...context, component, rows: rows.map(row => ({
      ...row, editable: !row.published && (row.state === null || isEditable(row.state)),
    })) };
  });
}
