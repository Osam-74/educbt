import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { asc, eq } from 'drizzle-orm';
import {
  createAnnouncement, publishAnnouncement, visibleAnnouncements,
  listAnnouncements, allowedAudiences, assignedClassIds,
  AnnouncementError,
} from '@/lib/comms/announcements';

export const dynamic = 'force-dynamic';

const AUDIENCE_LABELS: Record<string, string> = {
  school: 'Everyone in the school',
  class: 'A single class',
  level: 'A whole year group',
  department: 'A department',
  role: 'A role (all teachers, all students…)',
  guardians: 'Guardians of a class',
};

/**
 * Announcements (legacy templates/portal/announcements parity).
 *
 * Everyone sees what was addressed to them; leadership and class teachers
 * manage what they are allowed to address. The audience capability check is
 * in the service and repeated here only to decide what to RENDER — the
 * server action re-checks anyway, so a forged form gains nothing.
 */
export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  const query = await searchParams;

  const canManage = allowedAudiences(actor).length > 0;
  const visible = await visibleAnnouncements(actor);
  const mine = canManage ? await listAnnouncements(actor, 30) : [];

  const classOptions = canManage ? await forSchool(actor.schoolId, async (tx) => {
    const ids = new Set(await assignedClassIds(tx, actor));
    const rows = await tx
      .select({ id: schema.classes.id, name: schema.classes.displayName, levelId: schema.classes.levelId })
      .from(schema.classes)
      .where(eq(schema.classes.schoolId, actor.schoolId))
      .orderBy(asc(schema.classes.displayName));
    return rows.filter((c) => ids.has(c.id));
  }) : [];

  const levelOptions = actor.role === 'principal' || actor.role === 'vice_principal'
    ? await forSchool(actor.schoolId, async (tx) => tx
        .select({ id: schema.classLevels.id, name: schema.classLevels.name })
        .from(schema.classLevels)
        .where(eq(schema.classLevels.schoolId, actor.schoolId))
        .orderBy(asc(schema.classLevels.levelOrder)))
    : [];

  const departmentOptions = actor.role === 'principal' || actor.role === 'vice_principal'
    ? await forSchool(actor.schoolId, async (tx) => tx
        .select({ id: schema.departments.id, name: schema.departments.name })
        .from(schema.departments)
        .where(eq(schema.departments.schoolId, actor.schoolId))
        .orderBy(asc(schema.departments.name)))
    : [];

  async function create(formData: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const audience = String(formData.get('audience') ?? '');
    const refRaw = String(formData.get('audienceRef') ?? '');
    const refValue = refRaw && refRaw !== '' ? Number(refRaw.split(':')[0]) || refRaw : null;
    try {
      await createAnnouncement(a, {
        audience: audience as never,
        audienceRef: typeof refValue === 'number' ? refValue : null,
        subject: String(formData.get('subject') ?? ''),
        body: String(formData.get('body') ?? ''),
        publish: formData.get('publish') === 'on',
      });
    } catch (err) {
      const message = err instanceof AnnouncementError ? err.message : 'The announcement could not be saved.';
      redirect(`/portal/announcements?error=${encodeURIComponent(message)}`);
    }
    redirect('/portal/announcements?ok=Announcement+saved');
  }

  async function publish(formData: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const id = Number(formData.get('id'));
    if (!id) redirect('/portal/announcements?error=Unknown+announcement');
    try {
      await publishAnnouncement(a, id);
    } catch (err) {
      const message = err instanceof AnnouncementError ? err.message : 'The announcement could not be published.';
      redirect(`/portal/announcements?error=${encodeURIComponent(message)}`);
    }
    redirect('/portal/announcements?ok=Announcement+published');
  }

  return (
    <div className="portal-page">
      <h1 className="page-title">Announcements</h1>
      {query.error ? <p className="alert" role="alert">{query.error}</p> : null}
      {query.ok ? <p className="ok" role="status">{query.ok}</p> : null}

      {visible.length === 0 ? (
        <p className="muted empty-state">No announcements for you yet. School-wide notices and anything addressed to your class will appear here.</p>
      ) : (
        <ul className="announcement-list">
          {visible.map((a) => (
            <li key={a.id} className="announcement">
              <strong>{a.subject}</strong>
              <p>{a.body}</p>
              <p className="muted">
                {AUDIENCE_LABELS[a.audience] ?? a.audience}
                {a.publishedAt ? ` · ${new Date(a.publishedAt).toLocaleDateString('en-NG', { dateStyle: 'medium' })}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <section>
          <h2 className="sub-head">New announcement</h2>
          <p className="muted">
            A class teacher may address their own class. Only the principal or deputy may
            address the whole school or a whole role.
          </p>
          <form action={create}>
            <label htmlFor="subject">Subject</label>
            <input id="subject" name="subject" maxLength={200} required minLength={3} />

            <label htmlFor="body">Message</label>
            <textarea id="body" name="body" rows={4} required minLength={5}></textarea>

            <label htmlFor="audience">Audience</label>
            <select id="audience" name="audience" required>
              {allowedAudiences(actor).map((aud) => (
                <option key={aud} value={aud}>{AUDIENCE_LABELS[aud]}</option>
              ))}
            </select>

            <label htmlFor="audienceRef">Addressed to</label>
            <select id="audienceRef" name="audienceRef">
              {(classOptions.length > 0 || levelOptions.length > 0 || departmentOptions.length > 0) ? (
                <>
                  {classOptions.map((c) => <option key={`c${c.id}`} value={`${c.id}`}>Class: {c.name}</option>)}
                  {levelOptions.map((l) => <option key={`l${l.id}`} value={`${l.id}`}>Level: {l.name}</option>)}
                  {departmentOptions.map((d) => <option key={`d${d.id}`} value={`${d.id}`}>Department: {d.name}</option>)}
                  {(actor.role === 'principal' || actor.role === 'vice_principal') && (
                    <>
                      <option value="student">Role: all students</option>
                      <option value="teacher">Role: all teachers</option>
                      <option value="parent">Role: all parents</option>
                    </>
                  )}
                </>
              ) : (
                <option value="">Whole school (default)</option>
              )}
            </select>

            <label className="check">
              <input type="checkbox" name="publish" defaultChecked />
              Publish now (notify the audience immediately)
            </label>
            <button type="submit" className="btn">Save announcement</button>
          </form>

          {mine.length > 0 ? (
            <table className="tbl">
              <thead>
                <tr><th>Subject</th><th>Audience</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {mine.map((a) => (
                  <tr key={a.id}>
                    <td>{a.subject}</td>
                    <td>{AUDIENCE_LABELS[a.audience] ?? a.audience}</td>
                    <td>{a.status}</td>
                    <td>
                      {a.status === 'draft' && (actor.role === 'principal' || actor.role === 'vice_principal') ? (
                        <form action={publish}>
                          <input type="hidden" name="id" value={a.id} />
                          <button type="submit" className="btn btn-ghost">Publish</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
