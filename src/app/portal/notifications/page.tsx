import '../school-table.css';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { desc, eq } from 'drizzle-orm';
import { markRead, markAllRead, unreadCount, setPrefs, getPrefs, NOTIFICATION_TYPES, type NotificationType } from '@/lib/comms/notifications';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<NotificationType, string> = {
  result_published: 'Result published',
  exam_scheduled: 'Exam scheduled',
  exam_starting: 'Exam starting soon',
  score_submitted: 'Scores submitted',
  promotion_approved: 'Promotion approved',
  guardian_invite: 'Guardian invitation',
  password_reset: 'Password reset',
  announcement: 'Announcement',
  message_received: 'New message',
  exam_prep_opened: 'Exam prep opened',
  question_submitted: 'Questions submitted',
  question_withdrawn: 'Submission withdrawn',
  question_set_deleted: 'Draft set deleted',
  result_approved: 'Results approved',
};

/**
 * The notification center. Every user sees their own inbox only — the read is
 * scoped by the session user in the same transaction, and RLS bounds it to
 * the school. Mutations (mark read, preferences) are server actions; there is
 * no client-side authorization to bypass.
 *
 * Gmail-style row: the whole row is the click target (a full-width submit
 * button, since opening also has to mark the notification read) — there is
 * no separate "Open" link and no per-row "Mark read" button.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  const query = await searchParams;

  const { rows, unread, prefs } = await forSchool(actor.schoolId, async (tx) => {
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
      .where(eq(schema.notifications.userId, actor.userId))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(50);
    return { rows, unread: await unreadCount(tx, actor.schoolId, actor.userId), prefs: await getPrefs(tx, actor.schoolId, actor.userId) };
  });

  // One action for the whole row: mark read, then go wherever the
  // notification points (or just stay on the list if it has no link).
  async function open(formData: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const id = Number(formData.get('id'));
    const link = String(formData.get('link') ?? '');
    if (id) await forSchool(a.schoolId, (tx) => markRead(tx, a.schoolId, a.userId, [id]));
    redirect(link || '/portal/notifications');
  }

  async function markAll() {
    'use server';
    const a = await requireSchoolSession();
    await forSchool(a.schoolId, (tx) => markAllRead(tx, a.schoolId, a.userId));
    redirect('/portal/notifications');
  }

  async function savePrefs(formData: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const emailEnabled = formData.get('emailEnabled') === 'on';
    const muted = NOTIFICATION_TYPES.filter((t) => formData.get(`mute_${t}`) === 'on');
    await forSchool(a.schoolId, (tx) => setPrefs(tx, a.schoolId, a.userId, { emailEnabled, mutedTypes: muted }));
    redirect('/portal/notifications?ok=Email+preferences+saved');
  }

  return (
    <div className="portal-page">
      <h1 className="page-title">Notifications</h1>
      {query.error ? <p className="alert" role="alert">{query.error}</p> : null}
      {query.ok ? <p className="ok" role="status">{query.ok}</p> : null}

      <p className="muted">
        {unread > 0 ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'You are all caught up.'}
      </p>

      {rows.length === 0 ? (
        <p className="muted empty-state">
          Nothing here yet. Results publication, school announcements and messages you receive will appear in this list.
        </p>
      ) : (
        <>
          <div className="comm-toolbar">
            <form action={markAll}>
              <button type="submit" className="sa-btn sa-btn--ghost sa-btn--small" disabled={unread === 0}>Mark all as read</button>
            </form>
          </div>
          <div className="card sa-card inbox-card">
            <ul className="inbox-list">
              {rows.map((n) => (
                <li key={n.id}>
                  <form action={open}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="link" value={n.link ?? ''} />
                    <button type="submit" className={n.isRead ? 'inbox-row' : 'inbox-row unread'}>
                      <span className="inbox-row__main">
                        <span className="inbox-row__title">
                          {!n.isRead ? <span className="inbox-row__dot" aria-hidden="true" /> : null}
                          {n.title}
                        </span>
                        <span className="inbox-row__excerpt">{n.body || TYPE_LABELS[n.type as NotificationType] || n.type}</span>
                      </span>
                      <span className="inbox-row__meta">
                        <span className="inbox-row__type">{TYPE_LABELS[n.type as NotificationType] ?? n.type}</span>
                        <span className="inbox-row__time">
                          {new Date(n.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                        </span>
                      </span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <details className="prefs">
        <summary className="sub-head">Email preferences</summary>
        <p className="muted">
          In-app notifications are always delivered. Email is optional and per type — muting an
          email type never hides the in-app record.
        </p>
        <div className="card">
          <form action={savePrefs}>
            <label className="check">
              <input type="checkbox" name="emailEnabled" defaultChecked={prefs.emailEnabled} />
              Send me email notifications
            </label>
            {NOTIFICATION_TYPES.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" name={`mute_${t}`} defaultChecked={prefs.mutedTypes.includes(t)} />
                Mute email for &ldquo;{TYPE_LABELS[t]}&rdquo;
              </label>
            ))}
            <button type="submit" className="sa-btn sa-btn--primary">Save preferences</button>
          </form>
        </div>
      </details>
    </div>
  );
}
