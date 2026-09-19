/**
 * The examination timetable (legacy templates/portal/exams/timetable.php,
 * teacher/timetable.php, guardian/timetable.php — one page, three views).
 *
 * A timetable is not a stored document: it is a view over the papers of an
 * examination. The exam office sees the working draft and can move slots,
 * assign venues and invigilators and manage access codes. Teachers and
 * parents see it only once the examination is published — until then it is
 * a draft that may still be reshuffled.
 *
 * Visual parity with the plugin's own timetable page: one panel to pick the
 * examination, the schedule as a single sd-table, and — matching the
 * plugin's collapsible "Reschedule" row — a <details> toggle per paper that
 * reveals the edit form instead of showing it permanently in the row.
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  timetableForSeries,
  type TimetablePaper,
  reschedulePaper,
  setPaperInvigilator,
  regenerateAccessCode,
  releaseAccessCode,
  canManageTimetable,
  upcomingForStudent,
  generateSchedule,
  notifyClassTeachers,
} from '@/lib/exam/timetable';
import { guardianChildren } from '@/lib/results/family';
import { fmtDay, fmtTime } from '../exams/labels';
import { PortalIcon } from '../PortalShell';
import { PrintTrigger } from './PrintTrigger';
import '../../print.css';

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
      <div className="school-dashboard">
        <div className="sd-heading">
          <div>
            <p className="sd-eyebrow">Examinations</p>
            <h1>Exam timetable</h1>
          </div>
        </div>
        {children.length === 0 ? (
          <section className="sd-panel sd-panel--wide">
            <div style={{ padding: 20 }}><p className="muted">No children are linked to this account.</p></div>
          </section>
        ) : children.map((c) => (
          <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }} key={c.id}>
            <header><h2><PortalIcon name="timetable" />{c.firstName} {c.lastName}</h2></header>
            <div style={{ padding: '0 22px 20px' }}>
              {c.upcoming.length === 0 ? (
                <p className="muted" style={{ margin: '18px 0' }}>Nothing scheduled.</p>
              ) : (
                <div className="sd-table-wrap">
                  <table className="tbl">
                    <thead><tr><th>Subject</th><th>When</th><th>Duration</th><th>Venue</th></tr></thead>
                    <tbody>
                      {c.upcoming.map((p, i) => (
                        <tr key={i}>
                          <td><strong>{p.subjectName}</strong></td>
                          <td>{fmtDay(p.scheduledAt)}, {fmtTime(p.scheduledAt)}</td>
                          <td>{p.durationMinutes} min</td>
                          <td>{p.venue || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
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

  // Letterhead for the printed document — every school's timetable carries
  // its own crest and name, matching every other printed sheet in the app.
  const [branding] = await forSchool(actor.schoolId, async (tx) =>
    tx.select({
      name: schema.schools.name,
      address: schema.schools.address,
      logoUrl: schema.schools.logoUrl,
    })
      .from(schema.schools)
      .where(eq(schema.schools.id, actor.schoolId)));

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

  async function generate(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/timetable?series=${seriesId}`;
    const startsOn = String(formData.get('startsOn') ?? '');
    const endsOn = String(formData.get('endsOn') ?? '') || null;

    if (!startsOn) {
      redirect(`${back}&error=${encodeURIComponent('Set the first day of sitting.')}`);
    }

    const result = await generateSchedule(inner, seriesId, startsOn, endsOn);
    if (!result.ok) {
      redirect(`${back}&error=${encodeURIComponent(result.error)}`);
    }

    const parts: string[] = [];
    if (result.composed > 0) parts.push(`composed ${result.composed} new paper(s)`);
    if (result.short.length > 0) parts.push(`${result.short.length} subject(s) short of questions and skipped (${result.short.join('; ')})`);
    parts.push(`scheduled ${result.scheduled} paper(s) across the sitting window`);
    if (result.unplaced.length > 0) parts.push(`could not place: ${result.unplaced.join('; ')}`);

    redirect(`${back}&ok=${encodeURIComponent(parts.join('. ') + '.')}`);
  }

  async function notifyTeachers() {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/timetable?series=${seriesId}`;
    const result = await notifyClassTeachers(inner, seriesId);
    redirect(result.ok
      ? `${back}&ok=${encodeURIComponent(result.notified > 0
          ? `Notified ${result.notified} class teacher(s).`
          : 'No class teacher is assigned yet for any class in this examination.')}`
      : `${back}&error=${encodeURIComponent('Could not send notifications.')}`);
  }

  const papers = data?.papers ?? [];

  return (
    <div className="school-dashboard">
      <div className="no-print">
        <div className="sd-heading">
          <div>
            <p className="sd-eyebrow">Examination office</p>
            <h1>Timetable</h1>
            <p>
              Papers grouped by date for one examination. Move a slot, assign an
              invigilator, or manage its access code — all from the same row.
            </p>
          </div>
        </div>

        {query.error ? <p className="error">{query.error}</p> : null}
        {query.ok ? <p className="ok">{query.ok}</p> : null}

        {seriesList.length === 0 ? (
          <section className="sd-panel sd-panel--wide">
            <div style={{ padding: 20 }}><p className="muted">No examination has been created yet.</p></div>
          </section>
        ) : (
          <>
            <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
              <header><h2><PortalIcon name="timetable" />Choose examination</h2></header>
              <form method="get" className="eo-filters">
                <label htmlFor="series">
                  <span>Examination or assessment</span>
                  <select id="series" name="series" defaultValue={String(seriesId)}>
                    {seriesList.map((s) => (
                      <option key={s.id} value={s.id}>{s.title}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="sd-action sd-action--ghost">Show</button>
              </form>
            </section>

            {manage && seriesId ? (
              <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
                <header><h2><PortalIcon name="timetable" />Build and send</h2></header>
                <div style={{ padding: '0 22px 20px', display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <form action={generate} className="eo-filters" style={{ margin: 0 }}>
                    <input type="hidden" name="series" value={seriesId} />
                    <label htmlFor="startsOn">
                      <span>First day of sitting</span>
                      <input id="startsOn" name="startsOn" type="date" required />
                    </label>
                    <label htmlFor="endsOn">
                      <span>Last day of sitting</span>
                      <input id="endsOn" name="endsOn" type="date" />
                    </label>
                    <button type="submit" className="sd-action">
                      {papers.length > 0 ? 'Regenerate schedule' : 'Generate schedule'}
                    </button>
                  </form>

                  {papers.length > 0 ? (
                    <form action={notifyTeachers} style={{ margin: 0 }}>
                      <button type="submit" className="sd-action sd-action--ghost">Notify class teachers</button>
                    </form>
                  ) : null}

                  {papers.length > 0 ? <PrintTrigger /> : null}
                </div>
              </section>
            ) : null}

            {!data || (!data.series.released && !manage) ? (
              <section className="sd-panel sd-panel--wide">
                <div style={{ padding: 20 }}>
                  <p className="muted">The examination timetable has not been released yet. You will be notified when it is.</p>
                </div>
              </section>
            ) : papers.length === 0 ? (
              <section className="sd-panel sd-panel--wide">
                <div style={{ padding: 20 }}>
                  <p className="muted">
                    {manage
                      ? 'No papers scheduled for this examination yet — generate the schedule above.'
                      : 'No papers scheduled yet.'}
                  </p>
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      {data && papers.length > 0 && (data.series.released || manage) ? (
        <div className="doc">
          <div className="doc__sheet">
            <div className="doc__head">
              {branding?.logoUrl ? <img className="doc__crest" src={branding.logoUrl} alt="" /> : null}
              <p className="doc__school">{branding?.name ?? ''}</p>
              <p className="doc__title">Examination Timetable</p>
              <p className="muted doc__meta-line">
                {data.series.title}
                {branding?.address ? ` · ${branding.address}` : ''}
              </p>
            </div>

            <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px' }}>
              {data.series.released
                ? <span className="pill pill--published">Released</span>
                : <span className="pill pill--draft">Draft — not released</span>}
            </div>

            <div className="sd-table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Date</th><th>Day</th><th>Time</th><th>Subject</th><th>Class</th>
                    <th>Duration</th><th>Access Code</th><th>Invigilator</th>
                    {manage ? <th className="no-print" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {papers.map((p) => (
                    manage ? (
                      <PaperRow key={p.id} p={p} staffPool={staffPool}
                                reschedule={reschedule} invigilator={invigilator} code={code} />
                    ) : (
                      <tr key={p.id}>
                        <td>{fmtDay(p.scheduledAt)}</td>
                        <td>{p.scheduledAt
                          ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'long' }).format(p.scheduledAt)
                          : '—'}</td>
                        <td>{fmtTime(p.scheduledAt)}{p.closesAt ? ` – ${fmtTime(p.closesAt)}` : ''}</td>
                        <td><strong>{p.subjectName}</strong></td>
                        <td>{p.className ?? p.levelName ?? '—'}</td>
                        <td>{p.durationMinutes} min</td>
                        <td>—</td>
                        <td>{p.venue ? `${p.invigilatorName ?? '—'} · ${p.venue}` : (p.invigilatorName ?? '—')}</td>
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
            </div>

            <div className="doc__footer">
              <span>Signed: ______________________________</span>
              <span>Printed {new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' }).format(new Date())}</span>
            </div>

            {manage && !data.series.released ? (
              <p className="sd-footnote no-print">
                This timetable is a working draft. Publish the examination from the{' '}
                <Link href={`/portal/exams/${seriesId}`}>exam office</Link> to release it to
                teachers and set the sitting window the system enforces.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One scheduled paper. Its date/time, subject and access code sit in the
 * always-visible row (matching the plugin's own table); the reschedule and
 * invigilator forms live behind a <details> toggle (matching the plugin's
 * "Reschedule" button that reveals a row underneath) so a busy timetable
 * stays scannable.
 */
function PaperRow({
  p, staffPool, reschedule, invigilator, code,
}: {
  p: TimetablePaper;
  staffPool: { id: number; firstName: string; lastName: string }[];
  reschedule: (formData: FormData) => Promise<void>;
  invigilator: (formData: FormData) => Promise<void>;
  code: (formData: FormData) => Promise<void>;
}) {
  return (
    <>
      <tr>
        <td>{fmtDay(p.scheduledAt)}</td>
        <td>{p.scheduledAt
          ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', weekday: 'long' }).format(p.scheduledAt)
          : '—'}</td>
        <td>{fmtTime(p.scheduledAt)}{p.closesAt ? ` – ${fmtTime(p.closesAt)}` : ''}</td>
        <td><strong>{p.subjectName}</strong></td>
        <td>{p.className ?? p.levelName ?? '—'}</td>
        <td>{p.durationMinutes} min</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {p.requiresAccessCode && p.accessCode ? (
            <>
              <span className="eo-code">{p.accessCode}</span>
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
        <td>{p.invigilatorName ?? '—'}</td>
        <td className="no-print" style={{ whiteSpace: 'nowrap' }} />
      </tr>
      <tr className="no-print">
        <td colSpan={9} style={{ padding: 0, border: 0 }}>
          <details className="eo-toggle">
            <summary><PortalIcon name="edit" />Reschedule</summary>
            <div className="eo-slot-detail">
              <div className="eo-slot-detail__group">
                <h4>Date &amp; time</h4>
                <form action={reschedule}>
                  <input type="hidden" name="paperId" value={p.id} />
                  <label>Date &amp; time
                    <input name="scheduledAt" type="datetime-local" required
                           defaultValue={p.scheduledAt ? p.scheduledAt.toISOString().slice(0, 16) : ''} />
                  </label>
                  <label>Duration (min)
                    <input name="durationMinutes" type="number" min="1" max="600" style={{ width: 90 }}
                           defaultValue={p.durationMinutes} />
                  </label>
                  <label>Venue
                    <input name="venue" type="text" placeholder="Venue" defaultValue={p.venue ?? ''} />
                  </label>
                  <button type="submit" className="sd-action sd-action--ghost">Save slot</button>
                  <button type="submit" name="force" value="1" className="sd-action sd-action--ghost"
                          title="Place this paper even if the class is already sitting another paper in that window">
                    Save anyway
                  </button>
                </form>
              </div>
              <div className="eo-slot-detail__group">
                <h4>Invigilator</h4>
                <form action={invigilator}>
                  <input type="hidden" name="paperId" value={p.id} />
                  <label>Assign
                    <select name="staffId" defaultValue={String(p.invigilatorStaffId ?? 0)}>
                      <option value="0">— none —</option>
                      {staffPool.map((s) => (
                        <option key={s.id} value={s.id}>{s.firstName} {s.lastName}</option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="sd-action sd-action--ghost">Set</button>
                  <button type="submit" name="force" value="1" className="sd-action sd-action--ghost"
                          title="Assign anyway — for a CBT hall where one invigilator watches two papers from one room">
                    Anyway
                  </button>
                </form>
              </div>
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}
