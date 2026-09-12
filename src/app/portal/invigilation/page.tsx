/**
 * The invigilation schedule (legacy templates/portal/exams/invigilation.php,
 * teacher/invigilation.php).
 *
 * Nothing exists until someone builds it, so this page leads with that rather
 * than presenting an empty table. The office builds a proposal (spreading the
 * load, keeping a teacher away from their own subject), can swap anyone at
 * any time until the last paper is written, and is told when the timetable
 * has drifted underneath the schedule. A teacher sees only their own duties.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { desc, eq } from 'drizzle-orm';
import {
  canManageTimetable,
  invigilationPapers,
  invigilationDrift,
  proposeInvigilation,
  setPaperInvigilator,
  regenerateAccessCode,
  releaseAccessCode,
} from '@/lib/exam/timetable';
import { fmtDay, fmtTime } from '../exams/labels';

export const dynamic = 'force-dynamic';

export default async function InvigilationPage({
  searchParams,
}: {
  searchParams: Promise<{ series?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  if (actor.role === 'student' || actor.role === 'parent') notFound();

  const query = await searchParams;
  const manage = canManageTimetable(actor);

  const seriesList = await forSchool(actor.schoolId, async (tx) =>
    tx.select({ id: schema.examSeries.id, title: schema.examSeries.title })
      .from(schema.examSeries)
      .where(eq(schema.examSeries.schoolId, actor.schoolId))
      .orderBy(desc(schema.examSeries.id)));

  const seriesId = Number(query.series) || seriesList[0]?.id || 0;
  const data = seriesId ? await invigilationPapers(actor, seriesId) : null;
  if (seriesId && !data) notFound();

  const drift = manage && seriesId ? await invigilationDrift(actor, seriesId) : [];
  const papers = data?.papers ?? [];
  const assigned = papers.filter((p) => p.invigilatorStaffId).length;

  // ── Server actions (office only) ─────────────────────────────────────────
  async function build(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const result = await proposeInvigilation(inner, seriesId);
    const back = `/portal/invigilation?series=${seriesId}`;
    if (!result) redirect(back);

    const unfilled = result.unfilled.length
      ? ` ${result.unfilled.length} paper(s) could not be covered: ${result.unfilled.join('; ')}.`
      : '';
    redirect(`${back}&ok=${encodeURIComponent(
      `Assigned ${result.assigned} paper(s).${unfilled} You can swap anyone below.`,
    )}`);
  }

  async function invigilator(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const paperId = Number(formData.get('paperId'));
    const staffId = Number(formData.get('staffId'));
    const force = formData.get('force') === '1';
    const back = `/portal/invigilation?series=${seriesId}`;

    const result = await setPaperInvigilator(inner, paperId, staffId, force);
    const messages: Record<string, string> = {
      teaches_this_subject: 'A subject teacher never invigilates their own paper.',
      already_invigilating_then: 'That teacher is already invigilating another paper in that window. Use "Anyway" for a CBT hall where one invigilator watches two papers from one room.',
    };
    redirect(result.ok
      ? `${back}&ok=${encodeURIComponent('Invigilator saved.')}`
      : `${back}&error=${encodeURIComponent(messages[result.error] ?? 'Could not assign that invigilator.')}`);
  }

  async function code(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const paperId = Number(formData.get('paperId'));
    const back = `/portal/invigilation?series=${seriesId}`;

    if (formData.get('kind') === 'release') {
      const result = await releaseAccessCode(inner, paperId);
      redirect(result.ok
        ? `${back}&ok=${encodeURIComponent('Access code marked as released.')}`
        : `${back}&error=${encodeURIComponent('Generate a code first.')}`);
    }

    const result = await regenerateAccessCode(inner, paperId);
    redirect(result.ok
      ? `${back}&ok=${encodeURIComponent('Access code regenerated. The old code stopped working immediately.')}`
      : `${back}&error=${encodeURIComponent('Could not generate a code.')}`);
  }

  return (
    <>
      <h1 className="page-title">{manage ? 'Invigilation schedule' : 'My invigilation duties'}</h1>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">{query.ok}</p> : null}

      {seriesList.length === 0 ? (
        <p className="muted">No examination has been created yet. The schedule is built from an examination&apos;s timetable.</p>
      ) : (
        <>
          <form method="get" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', maxWidth: 420 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="series">Examination</label>
              <select id="series" name="series" defaultValue={String(seriesId)}>
                {seriesList.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-small">Show</button>
          </form>

          {papers.length === 0 ? (
            <p className="muted" style={{ marginTop: 20 }}>
              {manage
                ? 'This examination has no papers scheduled, so there is nothing to invigilate yet. '
                : 'You have no invigilation duties for this examination.'}
              {manage ? (
                <>
                  Schedule papers from the{' '}
                  <Link href={`/portal/exams/${seriesId}`}>exam office</Link> first.
                </>
              ) : null}
            </p>
          ) : (
            <>
              {manage ? (
                assigned === 0 ? (
                  <section style={{ marginTop: 24, borderLeft: '4px solid var(--forest)', paddingLeft: 16 }}>
                    <h2 className="sub-head">No invigilation schedule yet</h2>
                    <p className="muted" style={{ marginTop: -4 }}>
                      {papers.length} paper(s) are scheduled and none has an invigilator. Building
                      one assigns everybody automatically, spreading the load and keeping a teacher
                      away from their own subject. You can change any of it afterwards.
                    </p>
                    <form action={build}>
                      <button type="submit">Create invigilation schedule</button>
                    </form>
                  </section>
                ) : (
                  <p style={{ margin: '20px 0 10px' }}>
                    <strong>{assigned}</strong> of {papers.length} papers covered.
                    <form action={build} style={{ display: 'inline', marginLeft: 14 }}>
                      <button type="submit" className="btn-small">Fill any gaps automatically</button>
                    </form>
                  </p>
                )
              ) : (
                <p className="muted" style={{ marginTop: 20 }}>
                  Change anyone at any time until the last paper is written — see the exam office
                  if a duty is impossible. A swap is refused if the person teaches that subject or
                  is already in another hall at the same time.
                </p>
              )}

              {manage && drift.length > 0 ? (
                <section style={{ marginTop: 24, borderLeft: '4px solid #b45309', paddingLeft: 16 }}>
                  <h2 className="sub-head">The schedule no longer matches the timetable</h2>
                  <p className="muted" style={{ marginTop: -4 }}>
                    Papers have moved since this was built. None of these announce themselves on
                    the day, so they are worth settling now.
                  </p>
                  <ul className="muted" style={{ margin: '10px 0' }}>
                    {drift.map((issue, i) => <li key={i}>{issue}</li>)}
                  </ul>
                  <form action={build}>
                    <button type="submit">Apply the timetable changes</button>
                  </form>
                </section>
              ) : null}

              <table className="tbl" style={{ marginTop: 20 }}>
                <thead>
                  <tr>
                    <th>Date &amp; time</th><th>Subject</th><th>Class</th>
                    <th>Duration</th><th>Access code</th>
                    {manage ? <th>Invigilator</th> : <th>Hall</th>}
                  </tr>
                </thead>
                <tbody>
                  {papers.map((p) => (
                    <tr key={p.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {fmtDay(p.scheduledAt)}<br />
                        <span className="muted">{fmtTime(p.scheduledAt)}</span>
                      </td>
                      <td><strong>{p.subjectName}</strong></td>
                      <td>{p.className ?? p.levelName ?? '—'}</td>
                      <td>{p.durationMinutes} min</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {p.requiresAccessCode && p.accessCode ? (
                          <>
                            <strong style={{ letterSpacing: 1 }}>{p.accessCode}</strong>
                            {p.codeReleasedAt
                              ? <span className="pill pill--published" style={{ marginLeft: 6 }}>released</span>
                              : (
                                <form action={code} style={{ display: 'inline', marginLeft: 4 }}>
                                  <input type="hidden" name="paperId" value={p.id} />
                                  <input type="hidden" name="kind" value="release" />
                                  <button type="submit" className="btn-small">Release</button>
                                </form>
                              )}
                            {manage ? (
                              <form action={code} style={{ display: 'inline', marginLeft: 4 }}>
                                <input type="hidden" name="paperId" value={p.id} />
                                <input type="hidden" name="kind" value="regenerate" />
                                <button type="submit" className="btn-small" title="The old code stops working immediately">↻</button>
                              </form>
                            ) : null}
                          </>
                        ) : manage ? (
                          <form action={code} style={{ display: 'inline' }}>
                            <input type="hidden" name="paperId" value={p.id} />
                            <input type="hidden" name="kind" value="regenerate" />
                            <button type="submit" className="btn-small">Generate</button>
                          </form>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      {manage ? (
                        <td style={{ minWidth: 200 }}>
                          <form action={invigilator} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <input type="hidden" name="paperId" value={p.id} />
                            <select name="staffId" defaultValue={String(p.invigilatorStaffId ?? 0)}>
                              <option value="0">— nobody —</option>
                              {data!.staff.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                            <button type="submit" className="btn-small">Set</button>
                            <button type="submit" name="force" value="1" className="btn-small"
                                    title="Assign anyway — for a CBT hall where one invigilator watches two papers from one room">
                              Anyway
                            </button>
                          </form>
                        </td>
                      ) : (
                        <td>{p.venue || '—'}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>

              {manage ? (
                <p className="muted" style={{ marginTop: 12 }}>
                  Change anyone at any time until the last paper is written. A swap is refused if
                  the person teaches that subject or is already in another hall at the same time.
                  For CBT exams where a teacher can invigilate from one room, you can override a
                  clash with &quot;Anyway&quot;.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </>
  );
}
