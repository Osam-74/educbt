/**
 * School announcements (legacy AnnouncementService parity).
 *
 * The audience rules matter as much as the message: a class teacher may
 * address their own class, and only a principal or deputy may address the
 * whole school or a whole role. Without that, every teacher can mail 500
 * parents. The check lives here AND in the page — navigation never grants
 * permissions.
 *
 * Publishing an announcement resolves the audience to concrete user ids and
 * notifies them in-app (never inline email to the whole school — the email
 * fan-out goes through the queue like everything else).
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { notifyMany } from './notifications';

export const ANNOUNCEMENT_AUDIENCES = ['school', 'class', 'level', 'department', 'role', 'guardians'] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

/** Which roles may use which audience at all. */
const LEADERSHIP = ['principal', 'vice_principal'];

export function allowedAudiences(actor: Actor): AnnouncementAudience[] {
  if (LEADERSHIP.includes(actor.role)) return [...ANNOUNCEMENT_AUDIENCES];
  if (actor.role === 'teacher' || actor.role === 'exam_officer') return ['class', 'guardians'];
  return [];
}

/** The classes a teacher is authorised to address: their active assignments.
 *  Leadership may address any class. */
export async function assignedClassIds(tx: Tx, actor: Actor): Promise<number[]> {
  if (LEADERSHIP.includes(actor.role)) {
    const rows = await tx
      .select({ id: schema.classes.id })
      .from(schema.classes)
      .where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')));
    return rows.map((r) => r.id);
  }
  if (actor.staffId == null) return [];
  const rows = await tx
    .select({ classId: schema.staffAssignments.classId })
    .from(schema.staffAssignments)
    .where(and(
      eq(schema.staffAssignments.schoolId, actor.schoolId),
      eq(schema.staffAssignments.staffId, actor.staffId),
      eq(schema.staffAssignments.status, 'active'),
    ));
  const ids = rows.map((r) => r.classId).filter((id): id is number => id != null);
  return [...new Set(ids)];
}

/** Class ids currently enrolled (any active enrollment) — the class audience
 *  resolves through enrollments, not through a stored class_id on students. */
async function studentUserIdsInClasses(tx: Tx, schoolId: number, classIds: number[]): Promise<number[]> {
  if (classIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ userId: schema.students.userId })
    .from(schema.enrollments)
    .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
    .where(and(
      eq(schema.enrollments.schoolId, schoolId),
      inArray(schema.enrollments.classId, classIds),
      eq(schema.enrollments.status, 'active'),
      eq(schema.students.status, 'active'),
    ));
  return rows.map((r) => r.userId).filter((id): id is number => id != null);
}

async function guardianUserIdsOfStudentsInClasses(tx: Tx, schoolId: number, classIds: number[]): Promise<number[]> {
  if (classIds.length === 0) return [];
  const rows = await tx
    .selectDistinct({ userId: schema.guardians.userId })
    .from(schema.enrollments)
    .innerJoin(schema.guardianStudent, eq(schema.guardianStudent.studentId, schema.enrollments.studentId))
    .innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId))
    .where(and(
      eq(schema.enrollments.schoolId, schoolId),
      inArray(schema.enrollments.classId, classIds),
      eq(schema.enrollments.status, 'active'),
    ));
  return rows.map((r) => r.userId).filter((id): id is number => id != null);
}

export async function resolveAudience(
  tx: Tx,
  schoolId: number,
  audience: AnnouncementAudience,
  audienceRef: number | null,
): Promise<number[]> {
  if (audience === 'school') {
    const rows = await tx
      .select({ userId: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.schoolId, schoolId), eq(schema.users.status, 'active')));
    return rows.map((r) => r.userId);
  }

  if (audience === 'role') {
    const role = String(audienceRef ?? '') || null;
    if (!role) return [];
    const rows = await tx
      .select({ userId: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.schoolId, schoolId), eq(schema.users.role, role as never), eq(schema.users.status, 'active')));
    return rows.map((r) => r.userId);
  }

  // class / level / department / guardians all resolve through classes.
  let classIds: number[] = [];
  if (audience === 'class') {
    classIds = audienceRef ? [audienceRef] : [];
  } else if (audience === 'level' || audience === 'department') {
    const col = audience === 'level' ? schema.classes.levelId : schema.classes.departmentId;
    const rows = await tx
      .select({ id: schema.classes.id })
      .from(schema.classes)
      .where(and(
        eq(schema.classes.schoolId, schoolId),
        eq(schema.classes.status, 'active'),
        audienceRef ? eq(col, audienceRef) : sql`false`,
      ));
    classIds = rows.map((r) => r.id);
  }

  if (audience === 'guardians') {
    return guardianUserIdsOfStudentsInClasses(tx, schoolId, classIds);
  }
  return studentUserIdsInClasses(tx, schoolId, classIds);
}

export type CreateAnnouncementInput = {
  audience: AnnouncementAudience;
  audienceRef: number | null;
  subject: string;
  body: string;
  publish?: boolean;
};

export class AnnouncementError extends Error {}

/** Capability check: audience allowed for this actor, and the specific class
 *  (for class/guardians) must be one the actor teaches. */
export async function assertCanCreate(tx: Tx, actor: Actor, input: CreateAnnouncementInput): Promise<void> {
  if (!allowedAudiences(actor).includes(input.audience)) {
    throw new AnnouncementError(`Your role cannot address the ${input.audience} audience.`);
  }
  if ((input.audience === 'class' || input.audience === 'guardians') && !input.audienceRef) {
    throw new AnnouncementError('A class must be selected for this audience.');
  }
  if (input.audience === 'class' || input.audience === 'guardians') {
    const mine = await assignedClassIds(tx, actor);
    if (!mine.includes(input.audienceRef as number)) {
      throw new AnnouncementError('You can only address classes you are assigned to.');
    }
  }
  if (input.audience === 'role' && !LEADERSHIP.includes(actor.role)) {
    throw new AnnouncementError('Only the principal or deputy can address a whole role.');
  }
}

export async function createAnnouncement(actor: Actor, input: CreateAnnouncementInput): Promise<number> {
  if (!input.subject.trim() || input.subject.trim().length < 3) {
    throw new AnnouncementError('A subject of at least 3 characters is required.');
  }
  if (!input.body.trim() || input.body.trim().length < 5) {
    throw new AnnouncementError('A message of at least 5 characters is required.');
  }

  return forSchool(actor.schoolId, async (tx) => {
    await assertCanCreate(tx, actor, input);

    const inserted = await tx
      .insert(schema.announcements)
      .values({
        schoolId: actor.schoolId,
        authorUserId: actor.userId,
        audience: input.audience,
        audienceRef: input.audienceRef,
        subject: input.subject.trim().slice(0, 200),
        body: input.body.trim(),
        status: input.publish ? 'published' : 'draft',
        publishedAt: input.publish ? new Date() : null,
      })
      .returning({ id: schema.announcements.id });
    if (inserted.length === 0) throw new AnnouncementError('The announcement could not be saved.');
    const row = inserted[0]!;

    if (input.publish) {
      const userIds = await resolveAudience(tx, actor.schoolId, input.audience, input.audienceRef);
      await notifyMany(tx, actor.schoolId, userIds.map((userId) => ({
        userId,
        type: 'announcement' as const,
        title: input.subject.trim().slice(0, 200),
        body: input.body.trim().slice(0, 300),
        link: '/portal/announcements',
      })));
    }
    return row.id;
  });
}

/** Publishing resolves the audience and notifies it. Leadership only. */
export async function publishAnnouncement(actor: Actor, announcementId: number): Promise<number> {
  if (!LEADERSHIP.includes(actor.role)) {
    throw new AnnouncementError('Only the principal or deputy can publish announcements.');
  }
  return forSchool(actor.schoolId, async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.announcements)
      .where(and(eq(schema.announcements.id, announcementId), eq(schema.announcements.schoolId, actor.schoolId)));

    if (!row) throw new AnnouncementError('Announcement not found.');
    if (row.status === 'published') throw new AnnouncementError('This announcement is already published.');

    const userIds = await resolveAudience(tx, actor.schoolId, row.audience, row.audienceRef);
    await notifyMany(tx, actor.schoolId, userIds.map((userId) => ({
      userId,
      type: 'announcement' as const,
      title: row.subject,
      body: row.body.slice(0, 300),
      link: '/portal/announcements',
    })));

    const updated = await tx
      .update(schema.announcements)
      .set({ status: 'published', publishedAt: new Date() })
      .where(and(eq(schema.announcements.id, announcementId), eq(schema.announcements.status, 'draft')))
      .returning({ id: schema.announcements.id });
    return updated.length;
  });
}

export type AnnouncementRow = {
  id: number;
  subject: string;
  body: string;
  audience: AnnouncementAudience;
  audienceRef: number | null;
  status: 'draft' | 'published';
  authorName: string | null;
  createdAt: Date;
  publishedAt: Date | null;
};

/** All announcements for management views (principal/VP/author). */
export async function listAnnouncements(actor: Actor, limit = 50): Promise<AnnouncementRow[]> {
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.announcements.id,
        subject: schema.announcements.subject,
        body: schema.announcements.body,
        audience: schema.announcements.audience,
        audienceRef: schema.announcements.audienceRef,
        status: schema.announcements.status,
        createdAt: schema.announcements.createdAt,
        publishedAt: schema.announcements.publishedAt,
        authorUserId: schema.announcements.authorUserId,
      })
      .from(schema.announcements)
      .where(eq(schema.announcements.schoolId, actor.schoolId))
      .orderBy(desc(schema.announcements.createdAt))
      .limit(limit);

    return rows.map((r) => ({ ...r, authorName: null }));
  });
}

/**
 * The announcements a user may SEE: school-wide, their role, or anything
 * resolved through their own classes/children. Staff outside leadership see
 * class audiences only for classes they teach; guardians-audience
 * announcements are shown to those guardians by construction.
 */
export async function visibleAnnouncements(actor: Actor, limit = 20): Promise<AnnouncementRow[]> {
  return forSchool(actor.schoolId, async (tx) => {
    const all = await tx
      .select({
        id: schema.announcements.id,
        subject: schema.announcements.subject,
        body: schema.announcements.body,
        audience: schema.announcements.audience,
        audienceRef: schema.announcements.audienceRef,
        status: schema.announcements.status,
        createdAt: schema.announcements.createdAt,
        publishedAt: schema.announcements.publishedAt,
      })
      .from(schema.announcements)
      .where(and(eq(schema.announcements.schoolId, actor.schoolId), eq(schema.announcements.status, 'published')))
      .orderBy(desc(schema.announcements.publishedAt))
      .limit(200);

    // My class ids: from enrollment (student), from children (parent), from
    // assignments (teacher), or everything (leadership).
    let myClasses: Set<number>;
    if (LEADERSHIP.includes(actor.role)) {
      const rows = await tx.select({ id: schema.classes.id }).from(schema.classes).where(eq(schema.classes.schoolId, actor.schoolId));
      myClasses = new Set(rows.map((r) => r.id));
    } else if (actor.studentId != null) {
      const rows = await tx
        .select({ classId: schema.enrollments.classId })
        .from(schema.enrollments)
        .where(and(eq(schema.enrollments.schoolId, actor.schoolId), eq(schema.enrollments.studentId, actor.studentId), eq(schema.enrollments.status, 'active')));
      myClasses = new Set(rows.map((r) => r.classId));
    } else if (actor.role === 'parent') {
      const rows = await tx
        .select({ classId: schema.enrollments.classId })
        .from(schema.guardians)
        .innerJoin(schema.guardianStudent, eq(schema.guardianStudent.guardianId, schema.guardians.id))
        .innerJoin(schema.enrollments, and(
          eq(schema.enrollments.studentId, schema.guardianStudent.studentId),
          eq(schema.enrollments.status, 'active'),
        ))
        .where(and(eq(schema.guardians.schoolId, actor.schoolId), eq(schema.guardians.userId, actor.userId)));
      myClasses = new Set(rows.map((r) => r.classId));
    } else {
      const assigned = await assignedClassIds(tx, actor);
      myClasses = new Set(assigned);
    }

    // Resolve level/department membership for my classes.
    const classRows = myClasses.size > 0
      ? await tx
          .select({ id: schema.classes.id, levelId: schema.classes.levelId, departmentId: schema.classes.departmentId })
          .from(schema.classes)
          .where(and(eq(schema.classes.schoolId, actor.schoolId), inArray(schema.classes.id, [...myClasses])))
      : [];
    const myLevels = new Set(classRows.map((c) => c.levelId));
    const myDepartments = new Set(classRows.map((c) => c.departmentId).filter((d): d is number => d != null));

    // Parents also match the guardians audience for their children's classes.
    const parentClassIds = actor.role === 'parent' ? myClasses : new Set<number>();

    return all
      .filter((a) => {
        if (a.audience === 'school') return true;
        if (a.audience === 'role') return String(a.audienceRef ?? '') === actor.role;
        if (a.audience === 'class') return myClasses.has(a.audienceRef ?? -1);
        if (a.audience === 'level') return myLevels.has(a.audienceRef ?? -1);
        if (a.audience === 'department') return myDepartments.has(a.audienceRef ?? -1);
        if (a.audience === 'guardians') return parentClassIds.has(a.audienceRef ?? -1) || LEADERSHIP.includes(actor.role);
        return false;
      })
      .slice(0, limit)
      .map((r) => ({ ...r, authorName: null }));
  });
}
