import { redirect } from 'next/navigation';
import { asc, eq } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { listSeries, createSeries } from '@/lib/exam/compose';
import { forSchool, schema } from '@/db';
import { PortalIcon } from '../../PortalShell';
import { TYPE_LABEL, STATUS_LABEL, fmtDay } from '../labels';

export const dynamic = 'force-dynamic';

/**
 * Exam Papers (legacy templates/portal/exams/papers.php, $educbt_title = 'Exam Papers').
 *
 * The plugin puts everything on one page: the create-examination form sits
 * right above the list it feeds, so the office never leaves this page to
 * start one. This mirrors that — "Create examination" is an in-page form,
 * not a separate route, using the same createSeries() action as before.
 */
export default async function ExamPapersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requireSchoolSession();
  // The menu hides this link for other roles; the server refuses regardless.
  requireRole(actor, SCHOOL_WIDE);

  const query = await searchParams;
  const series = await listSeries(actor);

  const { sessions, terms } = await forSchool(actor.schoolId, async (tx) => ({
    sessions: await tx
      .select({ id: schema.academicSessions.id, title: schema.academicSessions.title, isCurrent: schema.academicSessions.isCurrent })
      .from(schema.academicSessions)
      .where(eq(schema.academicSessions.schoolId, actor.schoolId))
      .orderBy(asc(schema.academicSessions.id)),
    terms: await tx
      .select({
        id: schema.terms.id,
        sessionId: schema.terms.sessionId,
        title: schema.terms.title,
        isCurrent: schema.terms.isCurrent,
      })
      .from(schema.terms)
      .where(eq(schema.terms.schoolId, actor.schoolId))
      .orderBy(asc(schema.terms.position)),
  }));

  async function create(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const created = await createSeries(inner, {
        title: String(formData.get('title') ?? ''),
        seriesType: String(formData.get('seriesType') ?? ''),
        sessionId: String(formData.get('sessionId') ?? ''),
        termId: String(formData.get('termId') ?? ''),
        questionsPerStudent: String(formData.get('questionsPerStudent') ?? ''),
        durationMinutes: String(formData.get('durationMinutes') ?? ''),
        questionsOpenFrom: formData.get('questionsOpenFrom') || null,
        questionsOpenTo: formData.get('questionsOpenTo') || null,
      });

      destination = `/portal/exams/${Number(created.id)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The examination could not be created.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    // Outside the try/catch: redirect() throws, and catching it would turn the
    // success path into the error page.
    redirect(destination);
  }

  const defaultSession = sessions.find((s) => s.isCurrent) ?? sessions[0];
  const defaultTerm = terms.find((t) => t.isCurrent && t.sessionId === defaultSession?.id) ?? terms[0];

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Exam Papers</h1>
          <p>
            Every examination, CA test and practice paper ever created for this school —
            check the question bank, compose the papers, place them on the timetable, and publish.
          </p>
        </div>
      </div>

      {query.error ? <p className="error" style={{ marginBottom: 16 }}>{query.error}</p> : null}

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="exam" />Create examination</h2></header>
        <form action={create} className="eo-mini-form" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '0 22px 20px' }}>
          <label>
            Name
            <input name="title" required maxLength={191} placeholder="e.g. First Term Examination 2026/2027" />
          </label>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Type
              <select name="seriesType" defaultValue="examination" required>
                <option value="examination">Examination — terminal, reviewed, timetabled</option>
                <option value="ca_test">CA Test — continuous assessment, timetabled</option>
                <option value="practice">Practice — for revision, always available</option>
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Academic session
              <select name="sessionId" defaultValue={defaultSession?.id} required>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Term
              <select name="termId" defaultValue={defaultTerm?.id} required>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Questions per paper
              <input name="questionsPerStudent" type="number" min="1" max="200" defaultValue={40} required />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Duration (minutes)
              <input name="durationMinutes" type="number" min="5" max="300" placeholder="e.g. 60" required />
            </label>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Teachers submit questions from (optional)
              <input name="questionsOpenFrom" type="date" />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Teachers submit questions until (optional)
              <input name="questionsOpenTo" type="date" />
            </label>
          </div>

          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
            The sitting dates are not set here. They are set on the timetable once the papers exist.
          </p>

          <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Create examination</button>
        </form>
      </section>

      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="papers" />All examinations</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {series.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>
              No examinations yet. Use the form above to start the first one.
            </p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th><th>Type</th><th>Papers</th>
                    <th>Sitting window</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.id}>
                      <td>{s.title}</td>
                      <td>{TYPE_LABEL[s.seriesType] ?? s.seriesType}</td>
                      <td>
                        {s.paperCount}
                        {s.paperCount > 0 && s.unscheduledCount > 0 && s.seriesType !== 'practice' ? (
                          <span className="tag">{' '}{s.unscheduledCount} unscheduled</span>
                        ) : null}
                      </td>
                      <td>
                        {s.seriesType === 'practice' ? (
                          <span className="muted">Always available</span>
                        ) : (
                          `${fmtDay(s.sittingOpensAt)} – ${fmtDay(s.sittingClosesAt)}`
                        )}
                      </td>
                      <td>
                        <span className={`pill pill--${
                          s.status === 'published' ? 'published'
                            : s.status === 'draft' ? 'draft'
                              : 'submitted'
                        }`}>
                          {STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      </td>
                      <td><a href={`/portal/exams/${s.id}`}>Open</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
