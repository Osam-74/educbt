/**
 * In-app notifications (legacy NotificationService parity).
 *
 * A notification is typed, user-scoped, and carries the deep link to the thing
 * it is about — the legacy lesson was that a notice which lands you on the
 * question bank whatever it was about is barely a notification. Every type
 * here has a default link and a specific emitter in the domain.
 *
 * In-app delivery is unconditional: a muted type still gets its row, because
 * muting it would only hide the school's own record of what it told you.
 * Preferences gate the EMAIL fan-out only (see maybeQueueEmail).
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { forSchool, schema, type Tx } from '@/db';
import type { Actor } from '@/lib/session';
import { queueEmailForUser } from './email';

export const NOTIFICATION_TYPES = [
  'result_published', 'exam_scheduled', 'exam_starting', 'score_submitted',
  'promotion_approved', 'guardian_invite', 'password_reset', 'announcement',
  'message_received', 'exam_prep_opened', 'question_submitted',
  'question_withdrawn', 'question_set_deleted', 'result_approved',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Where a notification takes you when you open it. Same defaults as the
 *  legacy service, expressed as portal paths. */
const DEFAULT_LINKS: Record<NotificationType, string> = {
  result_published: '/portal/my-results',
  exam_scheduled: '/portal/timetable',
  exam_starting: '/portal',
  score_submitted: '/portal/exams',
  promotion_approved: '/portal',
  guardian_invite: '/portal/children',
  password_reset: '/portal/account/password',
  announcement: '/portal/announcements',
  message_received: '/portal/messages',
  exam_prep_opened: '/portal/exams',
  question_submitted: '/portal/exams',
  question_withdrawn: '/portal/exams',
  question_set_deleted: '/portal/exams',
  result_approved: '/portal/results',
};

export function defaultLink(type: NotificationType): string {
  return DEFAULT_LINKS[type];
}

export type NotificationInput = {
  userId: number;
  type: NotificationType;
  title: string;
  body?: string;
  link?: string;
};

/**
 * Notify many users with the same content. One multi-row INSERT, not 500
 * single ones — publishing results for a whole school fires several hundred
 * notifications at once, and a per-user loop is the difference between a
 * click and a timeout. Email fan-out is queued per user, never sent inline.
 */
export async function notifyMany(
  tx: Tx,
  schoolId: number,
  inputs: NotificationInput[],
): Promise<number> {
  const clean = inputs.filter(
    (n): n is NotificationInput & { title: string } => n.userId > 0 && NOTIFICATION_TYPES.includes(n.type) && n.title.trim().length > 0,
  );
  if (clean.length === 0) return 0;

  await tx.insert(schema.notifications).values(
    clean.map((n) => ({
      schoolId,
      userId: n.userId,
      type: n.type,
      title: n.title.trim().slice(0, 200),
      body: (n.body ?? '').trim(),
      link: (n.link ?? defaultLink(n.type)).slice(0, 500),
    })),
  );

  for (const n of clean) {
    await queueEmailForUser(tx, schoolId, n.userId, n.type, n.title, n.body ?? '', n.link ?? defaultLink(n.type));
  }
  return clean.length;
}

export async function notify(
  tx: Tx,
  schoolId: number,
  input: NotificationInput,
): Promise<number> {
  const n = await notifyMany(tx, schoolId, [input]);
  return n;
}

export type InboxRow = {
  id: number;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  isRead: boolean;
  createdAt: Date;
};

export async function inbox(
  tx: Tx,
  opts: { schoolId: number; userId: number; unreadOnly?: boolean; limit?: number },
): Promise<InboxRow[]> {
  const where = [eq(schema.notifications.schoolId, opts.schoolId), eq(schema.notifications.userId, opts.userId)];
  if (opts.unreadOnly) where.push(eq(schema.notifications.isRead, false));

  const rows = await tx
    .select({
      id: schema.notifications.id,
      type: schema.notifications.type,
      title: schema.notifications.title,
      body: schema.notifications.body,
      link: schema.notifications.link,
      isRead: schema.notifications.isRead,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .where(and(...where))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(Math.min(opts.limit ?? 30, 200));

  return rows;
}

export async function unreadCount(
  tx: Tx,
  schoolId: number,
  userId: number,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.notifications)
    .where(and(
      eq(schema.notifications.schoolId, schoolId),
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.isRead, false),
    ));
  return row?.count ?? 0;
}

/** Mark specific notifications read. Only unread rows are touched — a
 *  read_at that predates the notification's own history is a lie. */
export async function markRead(
  tx: Tx,
  schoolId: number,
  userId: number,
  ids: number[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(schema.notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(
      eq(schema.notifications.schoolId, schoolId),
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.isRead, false),
      inArray(schema.notifications.id, ids),
    ))
    .returning({ id: schema.notifications.id });
  return rows.length;
}

export async function markAllRead(tx: Tx, schoolId: number, userId: number): Promise<number> {
  const rows = await tx
    .update(schema.notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(
      eq(schema.notifications.schoolId, schoolId),
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.isRead, false),
    ))
    .returning({ id: schema.notifications.id });
  return rows.length;
}

export async function deleteAllRead(tx: Tx, schoolId: number, userId: number): Promise<number> {
  const rows = await tx
    .delete(schema.notifications)
    .where(and(
      eq(schema.notifications.schoolId, schoolId),
      eq(schema.notifications.userId, userId),
      eq(schema.notifications.isRead, true),
    ))
    .returning({ id: schema.notifications.id });
  return rows.length;
}

// ── Preferences ──────────────────────────────────────────────────────────────

export type NotificationPrefs = {
  emailEnabled: boolean;
  mutedTypes: NotificationType[];
};

export async function getPrefs(tx: Tx, schoolId: number, userId: number): Promise<NotificationPrefs> {
  const [row] = await tx
    .select({ emailEnabled: schema.notificationPrefs.emailEnabled, mutedTypes: schema.notificationPrefs.mutedTypes })
    .from(schema.notificationPrefs)
    .where(and(
      eq(schema.notificationPrefs.schoolId, schoolId),
      eq(schema.notificationPrefs.userId, userId),
    ));
  return { emailEnabled: row?.emailEnabled ?? true, mutedTypes: row?.mutedTypes ?? [] };
}

export async function setPrefs(
  tx: Tx,
  schoolId: number,
  userId: number,
  prefs: NotificationPrefs,
): Promise<void> {
  const muted = prefs.mutedTypes.filter((t) => NOTIFICATION_TYPES.includes(t));
  await tx
    .insert(schema.notificationPrefs)
    .values({ schoolId, userId, emailEnabled: prefs.emailEnabled, mutedTypes: muted })
    .onConflictDoUpdate({
      target: [schema.notificationPrefs.schoolId, schema.notificationPrefs.userId],
      set: { emailEnabled: prefs.emailEnabled, mutedTypes: muted, updatedAt: new Date() },
    });
}

/** The user-facing wrapper for portal pages. */
export async function markMyNotificationsRead(actor: Actor, ids: number[]): Promise<number> {
  return forSchool(actor.schoolId, (tx) => markRead(tx, actor.schoolId, actor.userId, ids));
}

export async function markAllMyNotificationsRead(actor: Actor): Promise<number> {
  return forSchool(actor.schoolId, (tx) => markAllRead(tx, actor.schoolId, actor.userId));
}
