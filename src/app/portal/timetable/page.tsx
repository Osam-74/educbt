/**
 * The examination timetable (legacy templates/portal/exams/timetable.php,
 * teacher/timetable.php, guardian/timetable.php — one page, three views).
 *
 * A timetable is not a stored document: it is a view over the papers of an
 * examination. The exam office sees the working draft and can move slots,
 * assign venues and invigilators and manage access codes. Teachers and
 * parents see it only once the examination is published — until then it is
 * a draft that may still be reshuffled.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  timetableForSeries,
  reschedulePaper,
  setPaperInvigilator,
  regenerateAccessCode,
  releaseAccessCode,
  canManageTimetable,
  upcomingForStudent,
} from '@/lib/exam/timetable';
import { guardianChildren } from '@/lib/results/family';
import { fmtDay, fmtTime } from '../exams/labels';

export const dynamic = 'force-dynamic';

export default async function TimetablePage({
  searchParams,
}: {
  searchParams: Promise<{ series?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  const query = await searchParams;

  // A student's timetable is their dashboard's paper list — nothing to add here.
  if (actor.role === 'student') redirect('/portal');

  const manage = canManageTimetable(actor);

  // ── Parent: each child's upcoming papers (legacy guardian/timetable.php) ──
  if (actor.role === 'parent') {
    const children = await forSchool(actor.schoolId, async (tx) => {
      const kids = await guardianChildren(tx, actor.userId);
      return Promise.all(kids.map(async (k) => ({
        ...k,
        upcoming: await upcomingForStudent(tx, actor.schoolId, k.id, 20),
      })));
    });

    return (
      <>
        <h1 className="page-title">Exam timetable</h1>
        {children.length === 0 ? (
          <p className="muted">No children are linked to this account.</p>
        ) : children.map((c) => (
          <section key={c.id} style={{ marginBottom: 24 }}>
            <h2 className="sub-head">{c.firstName} {c.lastName}</h2>
            {c.upcoming.length === 0 ? (
              <p className="muted">Nothing scheduled.</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>Subject</th><th>When</th><th>Duration</th><th>Venue</th></tr></thead>
                <tbody>
                  {c.upcoming.map((p, i) => (
                    <tr key={i}>
                      <td>{p.subjectName}</td>
                      <td>{fmtDay(p.scheduledAt)}, {fmtTime(p.scheduledAt)}</td>
                      <td>{p.durationMinutes} min</td>
                      <td>{p.venue || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        ))}
      </>
    );
  }

  // ── Staff: pick an examination ─────────────────────────────────────────────
  const seriesList = await forSchool(actor.schoolId, async (tx) =>
    tx.select({ id: schema.examSeries.id, title: schema.examSeries.title })
      .from(schema.examSeries)
      .where(eq(schema.examSeries.schoolId, actor.schoolId))
      .orderBy(desc(schema.examSeries.id)));

  const seriesId = Number(query.series) || seriesList[0]?.id || 0;
  const data = seriesId ? await timetableForSeries(actor, seriesId) : null;
  if (seriesId && !data) notFound();

  const staffPool = manage && data ? await forSchool(actor.schoolId, async (tx) =>
    tx.select({ id: schema.staff.id, firstName: schema.staff.firstName, lastName: schema.staff.lastName })
      .from(schema.staff)
      .where(and(eq(schema.staff.schoolId, actor.schoolId), eq(schema.staff.status, 'active'))))
    : [];

  // ── Server actions (office only) ─────────────────────────────────────────
  async function reschedule(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const paperId = Number(formData.get('paperId'));
    let destination: string;

    try {
      const result = await reschedulePaper(
        inner, paperId,
        {
          scheduledAt: String(formData.get('scheduledAt') ?? ''),
          durationMinutes: Number(formData.get('durationMinutes') ?? 0) || undefined,
          venue: String(formData.get('venue') ?? ''),
        },
        formData.get('force') === '1',
      );

      destination = result.ok
        ? `/portal/timetable?series=${seriesId}&ok=${encodeURIComponent('Slot saved.')}`
        : result.error === 'clash'
          ? `/portal/timetable?series=${seriesId}&error=${encodeURIComponent(`That class is already sitting ${result.clashWith} in that window. Tick "Override" to place both papers in one hall.`)}`
          : `/portal/timetable?series=${seriesId}&error=${encodeURIComponent('Could not save that slot.')}`;
    } catch {
      destination = `/portal/timetable?series=${seriesId}&error=${encodeURIComponent('Could not save that slot.')}`;
    }
    redirect(destination);
  }

  async function invigilator(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const paperId = Number(formData.get('paperId'));
    const staffId = Number(formData.get('staffId'));
    const force = formData.get('force') === '1';
    const messages: Record<string, string> = {
      teaches_this_subject: 'That teacher teaches this subject — a subject teacher never invigilates their own paper.',
      already_invigilating_then: 'That teacher is already invigilating another paper in that window. Tick "Override" for a CBT hall.',
    };

    const result = await setPaperInvigilator(inner, paperId, staffId, force);
    redirect(result.ok
      ? `/portal/timetable?series=${seriesId}&ok=${encodeURIComponent('Invigilator saved.')}`
      : `/portal/timetable?series=${seriesId}&error=${encodeURIComponent(messages[result.error] ?? 'Could not assign that invigilator.')}`);
  }

  async function code(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const paperId = Number(formData.get('paperId'));

    const back = `/portal/timetable?series=${seriesId}`;

    if (formData.get('kind') === 'release') {
      const result = await releaseAccessCode(inner, paperId);
      redirect(result.ok
        ? `${back}&ok=${encodeURIComponent('Access code marked as released.')}`
        : `${back}&error=${encodeURIComponent('Generate a code first.')}`);
    }

    const result = await regenerateAccessCode(inner, paperId);
    redirect(result.ok
      ? `${back}&ok=${encodeURIComponent('Access code generated. The old code (if any) has stopped working immediately.')}`
      : `${back}&error=${encodeURIComponent('Could not generate a code.')}`);
  }

  const papers = data?.papers ?? [];

  return (
    <>
      <h1 className="page-title">Timetable</h1>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">{query.ok}</p> : null}

      {seriesList.length === 0 ? (
        <p className="muted">No examination has been created yet.</p>
      ) : (
        <>
          <form method="get" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', maxWidth: 420 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="series">Examination or assessment</label>
              <select id="series" name="series" defaultValue={String(seriesId)}>
                {seriesList.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-small">Show</button>
          </form>

          {!data || (!data.series.released && !manage) ? (
            <p className="muted" style={{ marginTop: 20 }}>
              The examination timetable has not been released yet. You will be notified when it is.
            </p>
          ) : papers.length === 0 ? (
            <p className="muted" style={{ marginTop: 20 }}>
              {manage
                ? 'No papers scheduled for this examination yet — schedule them from the exam office first.'
                : 'No papers scheduled yet.'}
            </p>
          ) : (
            <>
              <p style={{ margin: '20px 0 10px' }}>
                <span className="tag">{data.series.title}</span>{' '}
                {data.series.released
                  ? <span className="pill pill--published">Released</span>
                  : <span className="pill pill--draft">Draft — not released</span>}
              </p>

              {!manage ? (
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th>Day</th><th>Time</th><th>Subject</th><th>Class</th><th>Venue</th><th>Invigilator</th></tr>
                  </thead>
                  <tbody>
                    {papers.map((p) => (
                      <tr key={p.id}>
                        <td>{fmtDay(p.scheduledAt)}</td>
                        <td>{p.scheduledAt
                          ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'long' }).format(p.scheduledAt)
                          : '—'}</td>
                        <td>{fmtTime(p.scheduledAt)}{p.closesAt ? ` – ${fmtTime(p.closesAt)}` : ''}</td>
                        <td><strong>{p.subjectName}</strong></td>
                        <td>{p.className ?? p.levelName ?? '—'}</td>
                        <td>{p.venue || '—'}</td>
                        <td>{p.invigilatorName ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Slot</th><th>Subject</th><th>Class</th><th>Venue</th>
                      <th>Invigilator</th><th>Access code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {papers.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <form action={reschedule} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 220 }}>
                            <input type="hidden" name="paperId" value={p.id} />
                            <input name="scheduledAt" type="datetime-local" required
                                   defaultValue={p.scheduledAt ? p.scheduledAt.toISOString().slice(0, 16) : ''} />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <input name="durationMinutes" type="number" min="1" max="600" style={{ width: 90 }}
                                     defaultValue={p.durationMinutes} title="Duration (minutes)" />
                              <input name="venue" type="text" placeholder="Venue" defaultValue={p.venue ?? ''} style={{ flex: 1 }} />
                            </div>
                            <button type="submit" className="btn-small">Save slot</button>
                            <button type="submit" name="force" value="1" className="btn-small"
                                    title="Place this paper even if the class is already sitting another paper in that window">
                              Save anyway
                            </button>
                          </form>
                        </td>
                        <td><strong>{p.subjectName}</strong><br />
                          <span className="muted" style={{ fontSize: 12 }}>
                            {fmtDay(p.scheduledAt)}, {fmtTime(p.scheduledAt)} · {p.durationMinutes} min
                          </span></td>
                        <td>{p.className ?? p.levelName ?? '—'}</td>
                        <td style={{ minWidth: 190 }}>
                          <form action={invigilator} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <input type="hidden" name="paperId" value={p.id} />
                            <select name="staffId" defaultValue={String(p.invigilatorStaffId ?? 0)}>
                              <option value="0">— none —</option>
                              {staffPool.map((s) => (
                                <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>
                              ))}
                            </select>
                            <button type="submit" className="btn-small">Set</button>
                            <button type="submit" name="force" value="1" className="btn-small"
                                    title="Assign anyway — for a CBT hall where one invigilator watches two papers from one room">
                              Anyway
                            </button>
                          </form>
                        </td>
                        <td>
                          {p.requiresAccessCode && p.accessCode ? (
                            <>
                              <strong style={{ letterSpacing: 1 }}>{p.accessCode}</strong>
                              <form action={code} style={{ display: 'inline', marginLeft: 4 }}>
                                <input type="hidden" name="paperId" value={p.id} />
                                <input type="hidden" name="kind" value="regenerate" />
                                <button type="submit" className="btn-small" title="Regenerate — the old code stops working immediately">↻</button>
                              </form>
                              {p.codeReleasedAt ? (
                                <span className="pill pill--published" style={{ marginLeft: 6 }}>released</span>
                              ) : (
                                <form action={code} style={{ display: 'inline', marginLeft: 4 }}>
                                  <input type="hidden" name="paperId" value={p.id} />
                                  <input type="hidden" name="kind" value="release" />
                                  <button type="submit" className="btn-small">Release</button>
                                </form>
                              )}
                            </>
                          ) : (
                            <form action={code} style={{ display: 'inline' }}>
                              <input type="hidden" name="paperId" value={p.id} />
                              <input type="hidden" name="kind" value="regenerate" />
                              <button type="submit" className="btn-small">Generate</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {manage && !data.series.released ? (
                <p className="muted" style={{ marginTop: 14 }}>
                  This timetable is a working draft. Publish the examination from the{' '}
                  <Link href={`/portal/exams/${seriesId}`}>exam office</Link> to release it to
                  teachers and set the sitting window the system enforces.
                </p>
              ) : null}
            </>
          )}
        </>
      )}
    </>
  );
}
