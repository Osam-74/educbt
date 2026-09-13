/**
 * Threaded messages (legacy AnnouncementService threads parity).
 *
 * Guardian↔staff and staff↔staff only. Student↔student messaging is
 * deliberately NOT supported — a school portal is not a chat app, and
 * moderating one is not a job any school signed up for.
 *
 * Scope rules, enforced here and not in the page:
 *   - a teacher may only open a thread with a guardian of a student in a
 *     class they teach (their assignments), or with a staff colleague;
 *   - a guardian may only be in threads opened for them by staff;
 *   - nobody may message arbitrary users outside their school.
 */

import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { notifyMany } from './notifications';

export class MessageError extends Error {}

const STAFF_ROLES = ['principal', 'vice_principal', 'exam_officer', 'teacher'];

async function assertParticipants(tx: Tx, actor: Actor, participantUserIds: number[]): Promise<void> {
  if (participantUserIds.length === 0) {
    throw new MessageError('Select at least one recipient.');
  }
  if (participantUserIds.includes(actor.userId)) {
    throw new MessageError('You cannot message yourself.');
  }

  const rows = await tx
    .select({ id: schema.users.id, role: schema.users.role, status: schema.users.status })
    .from(schema.users)
    .where(and(
      eq(schema.users.schoolId, actor.schoolId),
      inArray(schema.users.id, participantUserIds),
      eq(schema.users.status, 'active'),
    ));

  if (rows.length !== new Set(participantUserIds).size) {
    throw new MessageError('A recipient does not exist in this school.');
  }

  for (const row of rows) {
    if (row.role === 'student') {
      throw new MessageError('Student accounts cannot be messaged.');
    }
    if (row.role === 'platform_admin') {
      throw new MessageError('Platform accounts cannot be messaged.');
    }
  }

  // Teacher scope: guardians must belong to students in MY classes.
  if (actor.role === 'teacher' || actor.role === 'exam_officer') {
    const guardianTargets = rows.filter((r) => r.role === 'parent').map((r) => r.id);
    if (guardianTargets.length > 0) {
      const assigned = await tx
        .selectDistinct({ classId: schema.staffAssignments.classId })
        .from(schema.staffAssignments)
        .where(and(
          eq(schema.staffAssignments.schoolId, actor.schoolId),
          eq(schema.staffAssignments.staffId, actor.staffId ?? -1),
          eq(schema.staffAssignments.status, 'active'),
        ));
      const myClassIds = assigned.map((r) => r.classId).filter((id): id is number => id != null);
      if (myClassIds.length === 0) {
        throw new MessageError('You have no class assignments, so you cannot message guardians.');
      }
      const okGuardians = await tx
        .selectDistinct({ userId: schema.guardians.userId })
        .from(schema.guardians)
        .innerJoin(schema.guardianStudent, eq(schema.guardianStudent.guardianId, schema.guardians.id))
        .innerJoin(schema.enrollments, and(
          eq(schema.enrollments.studentId, schema.guardianStudent.studentId),
          eq(schema.enrollments.status, 'active'),
          inArray(schema.enrollments.classId, myClassIds),
        ))
        .where(and(eq(schema.guardians.schoolId, actor.schoolId), inArray(schema.guardians.userId, guardianTargets)));
      const allowed = new Set(okGuardians.map((r) => r.userId).filter((id): id is number => id != null));
      const outside = guardianTargets.filter((id) => !allowed.has(id));
      if (outside.length > 0) {
        throw new MessageError('You can only message guardians of students in your own classes.');
      }
    }
  }
}

export async function startThread(
  actor: Actor,
  input: { participantUserIds: number[]; subject: string; body: string },
): Promise<number> {
  if (!input.subject.trim() || input.subject.trim().length < 3) {
    throw new MessageError('A subject of at least 3 characters is required.');
  }
  if (!input.body.trim() || input.body.trim().length < 3) {
    throw new MessageError('A message of at least 3 characters is required.');
  }
  // Only staff may open threads. A parent answers; they do not cold-call staff.
  if (!STAFF_ROLES.includes(actor.role)) {
    throw new MessageError('Only staff can start a message thread.');
  }

  return forSchool(actor.schoolId, async (tx) => {
    await assertParticipants(tx, actor, input.participantUserIds);

    const insertedThread = await tx
      .insert(schema.messageThreads)
      .values({
        schoolId: actor.schoolId,
        subject: input.subject.trim().slice(0, 200),
        createdBy: actor.userId,
      })
      .returning({ id: schema.messageThreads.id });
    if (insertedThread.length === 0) throw new MessageError('The thread could not be created.');
    const thread = insertedThread[0]!;

    await tx.insert(schema.threadParticipants).values([
      { threadId: thread.id, schoolId: actor.schoolId, userId: actor.userId },
      ...input.participantUserIds.map((userId) => ({ threadId: thread.id, schoolId: actor.schoolId, userId })),
    ]);

    await tx.insert(schema.messages).values({
      threadId: thread.id,
      schoolId: actor.schoolId,
      senderUserId: actor.userId,
      body: input.body.trim(),
    });

    await notifyMany(tx, actor.schoolId, input.participantUserIds.map((userId) => ({
      userId,
      type: 'message_received' as const,
      title: `New message: ${input.subject.trim().slice(0, 160)}`,
      body: input.body.trim().slice(0, 200),
      link: `/portal/messages?thread=${thread.id}`,
    })));

    return thread.id;
  });
}

export async function replyToThread(actor: Actor, threadId: number, body: string): Promise<number> {
  if (!body.trim() || body.trim().length < 3) {
    throw new MessageError('A message of at least 3 characters is required.');
  }
  return forSchool(actor.schoolId, async (tx) => {
    const me = await tx
      .select({ userId: schema.threadParticipants.userId })
      .from(schema.threadParticipants)
      .where(and(
        eq(schema.threadParticipants.threadId, threadId),
        eq(schema.threadParticipants.schoolId, actor.schoolId),
        eq(schema.threadParticipants.userId, actor.userId),
      ));
    if (me.length === 0) throw new MessageError('You are not a participant in this thread.');

    const others = await tx
      .select({ userId: schema.threadParticipants.userId })
      .from(schema.threadParticipants)
      .where(and(
        eq(schema.threadParticipants.threadId, threadId),
        ne(schema.threadParticipants.userId, actor.userId),
      ));

    const [thread] = await tx
      .select({ subject: schema.messageThreads.subject })
      .from(schema.messageThreads)
      .where(and(eq(schema.messageThreads.id, threadId), eq(schema.messageThreads.schoolId, actor.schoolId)));
    if (!thread) throw new MessageError('Thread not found.');

    await tx.insert(schema.messages).values({
      threadId,
      schoolId: actor.schoolId,
      senderUserId: actor.userId,
      body: body.trim(),
    });

    await notifyMany(tx, actor.schoolId, others.map((o) => ({
      userId: o.userId,
      type: 'message_received' as const,
      title: `New message: ${thread.subject.slice(0, 160)}`,
      body: body.trim().slice(0, 200),
      link: `/portal/messages?thread=${threadId}`,
    })));

    await tx
      .update(schema.threadParticipants)
      .set({ lastReadAt: new Date() })
      .where(and(
        eq(schema.threadParticipants.threadId, threadId),
        eq(schema.threadParticipants.userId, actor.userId),
      ));

    return 1;
  });
}

export type ThreadRow = {
  id: number;
  subject: string;
  lastMessageAt: Date;
  messageCount: number;
  unread: boolean;
};

/** The threads I am a participant in, newest activity first. Unread = the
 *  last message is not mine and arrived after my last_read_at. */
export async function myThreads(actor: Actor, limit = 30): Promise<ThreadRow[]> {
  return forSchool(actor.schoolId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.messageThreads.id,
        subject: schema.messageThreads.subject,
        createdAt: schema.messageThreads.createdAt,
        lastReadAt: schema.threadParticipants.lastReadAt,
      })
      .from(schema.messageThreads)
      .innerJoin(schema.threadParticipants, and(
        eq(schema.threadParticipants.threadId, schema.messageThreads.id),
        eq(schema.threadParticipants.userId, actor.userId),
      ))
      .where(eq(schema.messageThreads.schoolId, actor.schoolId))
      .orderBy(desc(schema.messageThreads.createdAt))
      .limit(limit);

    if (rows.length === 0) return [];

    const counts = await tx
      .select({
        threadId: schema.messages.threadId,
        count: sql<number>`count(*)::int`,
        lastAt: sql<Date>`max(${schema.messages.createdAt})`,
        lastSender: sql<number>`(array_agg(${schema.messages.senderUserId} ORDER BY ${schema.messages.createdAt} DESC))[1]`,
      })
      .from(schema.messages)
      .where(inArray(schema.messages.threadId, rows.map((r) => r.id)))
      .groupBy(schema.messages.threadId);

    const byThread = new Map(counts.map((c) => [c.threadId, c]));
    return rows.map((r) => {
      const c = byThread.get(r.id);
      // sql<Date>`max(...)` can arrive as a string depending on driver/type,
      // so normalize before comparing or sorting.
      const lastAt = new Date((c?.lastAt ?? r.createdAt) as Date | string);
      const lastRead = r.lastReadAt ? new Date(r.lastReadAt) : null;
      const unread = c ? c.lastSender !== actor.userId && (!lastRead || lastAt > lastRead) : false;
      return { id: r.id, subject: r.subject, lastMessageAt: lastAt, messageCount: c?.count ?? 0, unread };
    }).sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  });
}

export type MessageRow = {
  id: number;
  senderUserId: number;
  body: string;
  createdAt: Date;
  senderName: string;
};

export async function threadMessages(actor: Actor, threadId: number): Promise<{ subject: string; messages: MessageRow[]; canReply: boolean }> {
  return forSchool(actor.schoolId, async (tx) => {
    const [thread] = await tx
      .select({ id: schema.messageThreads.id, subject: schema.messageThreads.subject })
      .from(schema.messageThreads)
      .where(and(eq(schema.messageThreads.id, threadId), eq(schema.messageThreads.schoolId, actor.schoolId)));
    if (!thread) throw new MessageError('Thread not found.');

    const me = await tx
      .select({ userId: schema.threadParticipants.userId })
      .from(schema.threadParticipants)
      .where(and(
        eq(schema.threadParticipants.threadId, threadId),
        eq(schema.threadParticipants.userId, actor.userId),
      ));
    if (me.length === 0) throw new MessageError('You are not a participant in this thread.');

    const rows = await tx
      .select({
        id: schema.messages.id,
        senderUserId: schema.messages.senderUserId,
        body: schema.messages.body,
        createdAt: schema.messages.createdAt,
        role: schema.users.role,
        staffFirst: schema.staff.firstName,
        staffLast: schema.staff.lastName,
        guardianName: schema.guardians.fullName,
      })
      .from(schema.messages)
      .leftJoin(schema.users, eq(schema.users.id, schema.messages.senderUserId))
      .leftJoin(schema.staff, and(eq(schema.staff.userId, schema.messages.senderUserId), eq(schema.staff.schoolId, actor.schoolId)))
      .leftJoin(schema.guardians, and(eq(schema.guardians.userId, schema.messages.senderUserId), eq(schema.guardians.schoolId, actor.schoolId)))
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(schema.messages.createdAt);

    await tx
      .update(schema.threadParticipants)
      .set({ lastReadAt: new Date() })
      .where(and(
        eq(schema.threadParticipants.threadId, threadId),
        eq(schema.threadParticipants.userId, actor.userId),
      ));

    return {
      subject: thread.subject,
      canReply: true,
      messages: rows.map((r) => ({
        id: r.id,
        senderUserId: r.senderUserId,
        body: r.body,
        createdAt: r.createdAt,
        senderName: r.staffFirst ? `${r.staffFirst} ${r.staffLast}` : (r.guardianName ?? 'Staff'),
      })),
    };
  });
}
