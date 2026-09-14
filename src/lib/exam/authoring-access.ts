import { and, eq, sql } from 'drizzle-orm';
import { schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { isSchoolWide } from '@/lib/queries';
import { settingsAccess } from '@/lib/settings/service';
import { authoringConfig, authoringScopeSchema, collectionIsOpen } from './authoring-validation';
import type { SetScope } from './sets';

export async function authoringActor(tx: Tx, actor: Actor) {
  const school = await settingsAccess(tx, actor);
  if (isSchoolWide(actor.role) && !actor.staffId) return school;
  if (!actor.staffId) throw new Error('An active staff account is required.');
  const [staff] = await tx.select({ id: schema.staff.id }).from(schema.staff).where(and(
    eq(schema.staff.id, actor.staffId), eq(schema.staff.userId, actor.userId),
    eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active')));
  if (!staff) throw new Error('An active linked staff account is required.');
  return school;
}
export async function authoringLock(tx: Tx, schoolId: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`educbt-authoring:${schoolId}`}, 0))`);
}
export async function permittedScope(tx: Tx, actor: Actor, input: SetScope) {
  const scope = authoringScopeSchema.parse(input);
  const school = await authoringActor(tx, actor);
  const [term] = await tx.select({ id: schema.terms.id }).from(schema.terms).where(and(
    eq(schema.terms.id, scope.termId), eq(schema.terms.sessionId, scope.sessionId), eq(schema.terms.schoolId, actor.schoolId)));
  const [subject] = await tx.select({ id: schema.subjects.id }).from(schema.subjects).where(and(eq(schema.subjects.id, scope.subjectId), eq(schema.subjects.schoolId, actor.schoolId)));
  const [level] = await tx.select({ id: schema.classLevels.id }).from(schema.classLevels).where(and(eq(schema.classLevels.id, scope.levelId), eq(schema.classLevels.schoolId, actor.schoolId)));
  const department = scope.departmentId === null ? true : (await tx.select({ id: schema.departments.id }).from(schema.departments).where(and(eq(schema.departments.id, scope.departmentId), eq(schema.departments.schoolId, actor.schoolId)))).length > 0;
  if (!term || !subject || !level || !department) throw new Error('Choose a valid subject, level and academic period in this school.');
  if (!isSchoolWide(actor.role)) {
    const [assignment] = await tx.select({ id: schema.staffAssignments.id }).from(schema.staffAssignments)
      .innerJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId)).where(and(
        eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.staffId, actor.staffId!),
        eq(schema.staffAssignments.subjectId, scope.subjectId), eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
        eq(schema.staffAssignments.status, 'active'), eq(schema.classes.levelId, scope.levelId),
        scope.departmentId === null ? sql`${schema.classes.departmentId} IS NULL` : eq(schema.classes.departmentId, scope.departmentId)));
    if (!assignment) throw new Error('You are not assigned to this subject and level.');
  }
  return school;
}
export async function permittedCollection(tx: Tx, actor: Actor, scope: SetScope, settings: Record<string, unknown>) {
  const config = authoringConfig(settings);
  const seriesId = scope.seriesId || config.seriesId;
  if (!seriesId) throw new Error('The question bank is closed. Ask the exam office to open a submission window.');
  const [series] = await tx.select().from(schema.examSeries).where(and(eq(schema.examSeries.id, seriesId), eq(schema.examSeries.schoolId, actor.schoolId)));
  if (!series || series.sessionId !== scope.sessionId || series.termId !== scope.termId ||
    (scope.seriesId === 0 ? series.seriesType !== 'examination' : series.seriesType === 'examination')) throw new Error('The collection window does not match this question set.');
  if (series.seriesType !== 'practice' && config.seriesId !== series.id) throw new Error('This is not the active submission window.');
  if (series.seriesType !== 'examination' && scope.examType !== 'objective') throw new Error('CA and practice collections accept objective questions only.');
  if (!collectionIsOpen(series)) throw new Error('This submission window is not open.');
  return config;
}
export async function editableSetAccess(tx: Tx, actor: Actor, set: typeof schema.questionSets.$inferSelect) {
  const school = await permittedScope(tx, actor, set);
  if (!isSchoolWide(actor.role) && set.teacherId !== actor.staffId) throw new Error('This set belongs to another teacher.');
  await permittedCollection(tx, actor, set, school.settings);
}
