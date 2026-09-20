import '../school-table.css';
import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { and, asc, eq, ne } from 'drizzle-orm';
import { startThread, replyToThread, myThreads, threadMessages, MessageError } from '@/lib/comms/messages';

export const dynamic = 'force-dynamic';

/** Staff may open threads; parents answer them. */
const STAFF_ROLES = ['principal', 'vice_principal', 'exam_officer', 'teacher'];

/**
 * Messages (legacy message threads parity). Guardian↔staff and staff↔staff
 * only — student accounts are not reachable. A teacher's recipient list is
 * resolved from their own assignments, and the service re-checks scope on
 * submit, so a forged recipient id gains nothing.
 *
 * The composer only ever shows on the inbox view (no thread open) — an open
 * thread shows its reply box instead, never both at once. "Compose" clears
 * ?thread to get back to the inbox and start a new one.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ thread?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  const query = await searchParams;

  // threadMessages() marks the thread (and its notification) read as a
  // side effect — it must run BEFORE myThreads() below, or the just-opened
  // thread still shows its stale "unread" flag in the very same render
  // (myThreads would have read lastReadAt before the update committed).
  const threadId = Number(query.thread) || 0;
  const open = threadId ? await threadMessages(actor, threadId).catch(() => null) : null;
  const threads = await myThreads(actor);

  const canCompose = STAFF_ROLES.includes(actor.role);

  // Recipients a composer may pick: staff colleagues always; for teachers and
  // exam officers, guardians of students in their assigned classes; leadership
  // may address any guardian in the school. (The service re-checks scope on
  // submit, so this list is only a convenience.)
  const classScoped = actor.role === 'teacher' || actor.role === 'exam_officer';
  const recipients = (canCompose && !open) ? await forSchool(actor.schoolId, async (tx) => {
    const staffRows = await tx
      .select({ userId: schema.staff.userId, firstName: schema.staff.firstName, lastName: schema.staff.lastName, role: schema.staff.role })
      .from(schema.staff)
      .where(and(
        eq(schema.staff.schoolId, actor.schoolId),
        eq(schema.staff.status, 'active'),
        ne(schema.staff.userId, actor.userId),
      ))
      .orderBy(asc(schema.staff.lastName));

    const guardianRows = classScoped
      ? await tx
        .selectDistinct({ userId: schema.guardians.userId, fullName: schema.guardians.fullName })
        .from(schema.staffAssignments)
        .innerJoin(schema.enrollments, and(
          eq(schema.enrollments.classId, schema.staffAssignments.classId),
          eq(schema.enrollments.status, 'active'),
        ))
        .innerJoin(schema.guardianStudent, eq(schema.guardianStudent.studentId, schema.enrollments.studentId))
        .innerJoin(schema.guardians, eq(schema.guardians.id, schema.guardianStudent.guardianId))
        .where(and(
          eq(schema.staffAssignments.schoolId, actor.schoolId),
          eq(schema.staffAssignments.staffId, actor.staffId ?? -1),
          eq(schema.staffAssignments.status, 'active'),
        ))
        .orderBy(asc(schema.guardians.fullName))
      : await tx
        .select({ userId: schema.guardians.userId, fullName: schema.guardians.fullName })
        .from(schema.guardians)
        .where(eq(schema.guardians.schoolId, actor.schoolId))
        .orderBy(asc(schema.guardians.fullName));

    return {
      staff: staffRows.filter((s) => s.userId != null),
      guardians: guardianRows.filter((g) => g.userId != null),
    };
  }) : null;

  async function compose(formData: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const participants = formData.getAll('participants').map((v) => Number(v)).filter((n) => n > 0);
    // redirect() throws NEXT_REDIRECT, so the success redirect must live
    // outside the try — otherwise the catch swallows it and reports failure.
    let threadId = 0;
    try {
      threadId = await startThread(a, {
        participantUserIds: participants,
        subject: String(formData.get('subject') ?? ''),
        body: String(formData.get('body') ?? ''),
      });
    } catch (err) {
      const message = err instanceof MessageError ? err.message : 'The message could not be sent.';
      redirect(`/portal/messages?error=${encodeURIComponent(message)}`);
    }
    redirect(`/portal/messages?thread=${threadId}&ok=Message+sent`);
  }

  async function reply(formData: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const id = Number(formData.get('thread'));
    try {
      await replyToThread(a, id, String(formData.get('body') ?? ''));
    } catch (err) {
      const message = err instanceof MessageError ? err.message : 'The reply could not be sent.';
      redirect(`/portal/messages?thread=${id}&error=${encodeURIComponent(message)}`);
    }
    redirect(`/portal/messages?thread=${id}&ok=Reply+sent`);
  }

  return (
    <div className="portal-page">
      <h1 className="page-title">Messages</h1>
      {query.error ? <p className="alert" role="alert">{query.error}</p> : null}
      {query.ok ? <p className="ok" role="status">{query.ok}</p> : null}

      {threads.length === 0 && !open ? (
        <p className="muted empty-state">
          No messages yet. Staff can start a thread with a colleague or with the guardian of a student in their class.
        </p>
      ) : null}

      {threads.length > 0 ? (
        <div className="card sa-card inbox-card" style={{ marginBottom: open ? 20 : 0 }}>
          <ul className="inbox-list thread-list">
            {threads.map((t) => (
              <li key={t.id} className={t.id === threadId ? 'thread active' : 'thread'}>
                <a href={`/portal/messages?thread=${t.id}`} className={t.unread ? 'inbox-row unread' : 'inbox-row'}>
                  <span className="inbox-row__main">
                    <span className="inbox-row__title">
                      {t.unread ? <span className="inbox-row__dot" aria-hidden="true" /> : null}
                      {t.subject}
                    </span>
                    <span className="inbox-row__excerpt">
                      {t.messageCount} message{t.messageCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className="inbox-row__meta">
                    <span className="inbox-row__time">
                      {new Date(t.lastMessageAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {open ? (
        <section className="card sa-card thread-view">
          <div className="thread-view__head">
            <h2 style={{ margin: 0, fontSize: 16 }}>{open.subject}</h2>
            {canCompose ? <a href="/portal/messages" className="sa-btn sa-btn--small">Compose new message</a> : null}
          </div>
          <ul className="message-list">
            {open.messages.map((m) => (
              <li key={m.id} className={m.senderUserId === actor.userId ? 'message mine' : 'message'}>
                <strong>{m.senderUserId === actor.userId ? 'You' : m.senderName}</strong>
                <p>{m.body}</p>
                <span className="muted">{new Date(m.createdAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </li>
            ))}
          </ul>
          <form action={reply} className="reply-form">
            <input type="hidden" name="thread" value={threadId} />
            <label htmlFor="reply-body" style={{ display: 'block', marginBottom: 6, fontWeight: 550, fontSize: '13.5px' }}>Reply</label>
            <textarea id="reply-body" name="body" rows={3} required minLength={3}
              style={{ width: '100%', marginBottom: 12, padding: '9px 12px', border: '1px solid #d7dedb', borderRadius: 9, font: 'inherit', fontSize: 14 }}></textarea>
            <button type="submit" className="sa-btn sa-btn--primary">Send reply</button>
          </form>
        </section>
      ) : null}

      {canCompose && recipients ? (
        <section className="card sa-card" style={{ marginTop: threads.length > 0 ? 24 : 0 }}>
          <h2>New message</h2>
          <form action={compose}>
            <fieldset className="form-grid">
              <label htmlFor="subject">Subject
                <input id="subject" name="subject" maxLength={200} required minLength={3} />
              </label>
              <label htmlFor="participants">To
                <select id="participants" name="participants" multiple required size={Math.min(8, recipients.staff.length + recipients.guardians.length)}>
                  {recipients.staff.map((s) => (
                    <option key={`s${s.userId}`} value={s.userId!}>{s.firstName} {s.lastName} (staff)</option>
                  ))}
                  {recipients.guardians.map((g) => (
                    <option key={`g${g.userId}`} value={g.userId!}>{g.fullName} (guardian)</option>
                  ))}
                </select>
              </label>
            </fieldset>
            <p className="muted" style={{ marginTop: -6 }}>
              Hold Ctrl (or Cmd) to select several. Guardians listed are those of students in your classes.
            </p>
            <label htmlFor="compose-body" style={{ display: 'block', marginBottom: 6, fontWeight: 550, fontSize: '13.5px' }}>Message</label>
            <textarea id="compose-body" name="body" rows={4} required minLength={3}
              style={{ width: '100%', marginBottom: 14, padding: '9px 12px', border: '1px solid #d7dedb', borderRadius: 9, font: 'inherit', fontSize: 14 }}></textarea>
            <button type="submit" className="sa-btn sa-btn--primary">Send message</button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
