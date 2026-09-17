import { and, eq, asc, sql } from 'drizzle-orm';
import { forSchool, schema } from '@/db';
import type { Actor } from '@/lib/session';
import { isSchoolWide } from '@/lib/queries';
import { authoringActor, authoringLock } from './authoring-access';
import { authoringConfig, collectionSchema } from './authoring-validation';
import { configLock } from '@/lib/settings/service';

export async function collectionView(actor: Actor) {
  return forSchool(actor.schoolId, async tx => {
    const school = await authoringActor(tx, actor);
    const scopes = await tx.select({ subjectId: schema.staffAssignments.subjectId, levelId: schema.classes.levelId,
      departmentId: schema.classes.departmentId, subject: schema.subjects.name, level: schema.classLevels.name,
      department: schema.departments.name }).from(schema.staffAssignments)
      .innerJoin(schema.classes, eq(schema.classes.id, schema.staffAssignments.classId))
      .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.classes.levelId))
      .innerJoin(schema.subjects, eq(schema.subjects.id, schema.staffAssignments.subjectId))
      .leftJoin(schema.departments, eq(schema.departments.id, schema.classes.departmentId))
      .where(and(eq(schema.staffAssignments.schoolId, actor.schoolId), eq(schema.staffAssignments.status, 'active'),
        eq(schema.staffAssignments.assignmentType, 'subject_teacher'),
        isSchoolWide(actor.role) ? undefined : eq(schema.staffAssignments.staffId, actor.staffId!)));
    return { config: authoringConfig(school.settings), settings: school.settings, scopes: [...new Map(scopes.map(s => [`${s.subjectId}:${s.levelId}:${s.departmentId ?? ''}`, s])).values()],
      series: await tx.select().from(schema.examSeries).where(eq(schema.examSeries.schoolId, actor.schoolId)).orderBy(asc(schema.examSeries.title)) };
  });
}
export async function saveCollection(actor: Actor, input: unknown) {
  if (!isSchoolWide(actor.role)) throw new Error('Only the exam office can configure question collection.');
  const value = collectionSchema.parse(input);
  return forSchool(actor.schoolId, async tx => {
    await authoringLock(tx, actor.schoolId);
    await configLock(tx, actor.schoolId);
    const school = await authoringActor(tx, actor);
    if (value.seriesId) {
      const [series] = await tx.select().from(schema.examSeries).where(and(eq(schema.examSeries.id, value.seriesId), eq(schema.examSeries.schoolId, actor.schoolId)));
      if (!series || series.seriesType === 'practice' || !['draft', 'open'].includes(series.status)) throw new Error('Choose a draft or open examination/CA collection.');
      if (!series.questionsOpenFrom || !series.questionsOpenTo || series.questionsOpenFrom >= series.questionsOpenTo) throw new Error('Set valid submission dates in Exam Office before opening this collection.');
    }
    // Update only our JSON key: concurrent branding/academic saves must survive.
    await tx.update(schema.schools).set({ settings: sql`jsonb_set(${schema.schools.settings}, '{questionBank}', ${JSON.stringify(value)}::jsonb)` }).where(eq(schema.schools.id, actor.schoolId));
    await tx.insert(schema.auditLog).values({ schoolId: actor.schoolId, actorUserId: actor.userId, actorRole: actor.role,
      action: 'question_bank.configured', entityType: 'schools', entityId: actor.schoolId,
      before: authoringConfig(school.settings), after: value });
  });
}
