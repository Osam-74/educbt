import { notFound, redirect } from 'next/navigation';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import {
  questionAvailability,
  composeSeries,
  scheduleSeries,
  publishSeries,
  seriesPapers,
} from '@/lib/exam/compose';
import { TYPE_LABEL, STATUS_LABEL, fmtDay, fmtTime, addMinutes } from '../labels';

export const dynamic = 'force-dynamic';

const PILL: Record<string, string> = {
  published: 'pill--published',
  draft: 'pill--draft',
};

export default async function SeriesPage({
  params,
  searchParams,
}: {
  params: Promise<{ seriesId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const { seriesId: raw } = await params;
  const query = await searchParams;
  const seriesId = Number(raw);

  const actor = await requireSchoolSession();
  requireRole(actor, SCHOOL_WIDE);

  if (!Number.isInteger(seriesId) || seriesId <= 0) notFound();

  let data: Awaited<ReturnType<typeof seriesPapers>>;
  let availability: Awaited<ReturnType<typeof questionAvailability>>;

  try {
    data = await seriesPapers(actor, seriesId);
    availability = await questionAvailability(actor, seriesId);
  } catch {
    notFound();
  }

  const { series, papers } = data;
  const isPractice = series.seriesType === 'practice';
  const published = series.status === 'published';
  const unscheduled = papers.filter((p) => !p.scheduledAt && p.status !== 'cancelled').length;
  const shortages = availability.rows.filter((r) => !r.ready);
  const readyToPublish = papers.length > 0
    && (isPractice || (unscheduled === 0 && series.sittingOpensAt && series.sittingClosesAt));

  async function compose() {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const result = await composeSeries(inner, seriesId);

      destination = result.short.length > 0
        ? `/portal/exams/${seriesId}?error=${encodeURIComponent(
            `Composed ${result.created} paper(s). These subjects had too few approved questions: ${result.short.join('; ')}.`,
          )}`
        : `/portal/exams/${seriesId}?ok=${encodeURIComponent(
            `Composed ${result.created} paper(s).${result.skipped > 0 ? ` ${result.skipped} already composed.` : ''}`,
          )}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Composition failed.';
      destination = `/portal/exams/${seriesId}?error=${encodeURIComponent(message)}`;
    }

    redirect(destination);
  }

  async function schedule(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const result = await scheduleSeries(
        inner,
        seriesId,
        String(formData.get('startsOn') ?? ''),
        String(formData.get('endsOn') ?? '') || null,
        Number(formData.get('slotsPerDay') ?? 2),
      );

      destination = result.unplaced.length > 0
        ? `/portal/exams/${seriesId}?error=${encodeURIComponent(
            `Scheduled ${result.scheduled} paper(s). ${result.unplaced.length} paper(s) could not be placed on the timetable: ${result.unplaced.join('; ')}. Shorten the window or add more slots per day.`,
          )}`
        : `/portal/exams/${seriesId}?ok=${encodeURIComponent(
            `Scheduled ${result.scheduled} paper(s). Review the timetable below before publishing.`,
          )}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Scheduling failed.';
      destination = `/portal/exams/${seriesId}?error=${encodeURIComponent(message)}`;
    }

    redirect(destination);
  }

  async function publish() {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const count = await publishSeries(inner, seriesId);

      destination = `/portal/exams/${seriesId}?ok=${encodeURIComponent(
        `Published. ${count} paper(s) are now available to students${isPractice ? ' at any time' : ' on their timetable'}.`,
      )}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Publishing failed.';
      destination = `/portal/exams/${seriesId}?error=${encodeURIComponent(message)}`;
    }

    redirect(destination);
  }

  return (
    <>
      <h1 className="page-title">{series.title}</h1>

      <p>
        <span className="tag">{TYPE_LABEL[series.seriesType] ?? series.seriesType}</span>{' '}
        <span className={`pill ${PILL[series.status] ?? 'pill--submitted'}`}>
          {STATUS_LABEL[series.status] ?? series.status}
        </span>
      </p>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">{query.ok}</p> : null}

      {!isPractice ? (
        <p className="muted">
          Question window for teachers:{' '}
          {series.questionsOpenFrom || series.questionsOpenTo
            ? `${fmtDay(series.questionsOpenFrom)} – ${fmtDay(series.questionsOpenTo)}`
            : 'not set (questions accepted any time)'}
          <br />
          Sitting window:{' '}
          {series.sittingOpensAt
            ? `${fmtDay(series.sittingOpensAt)} – ${fmtDay(series.sittingClosesAt)}`
            : 'not scheduled yet'}
        </p>
      ) : (
        <p className="muted">
          A practice examination has no timetable — once published, students can
          sit it at any time, and it never counts towards their results.
        </p>
      )}

      {/* ── Step 1: question availability ─────────────────────────────────── */}
      <h2 className="sub-head">Questions available</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        Each paper needs {availability.perStudent} approved objective questions.
        Only approved questions can compose — a set still being written or
        awaiting review does not count.
      </p>

      {availability.rows.length === 0 ? (
        <p className="muted">
          No approved question sets apply to this examination yet. For an
          examination, approved terminal sets are used; for a CA Test or Practice,
          teachers write their questions into this examination first.
        </p>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>Subject</th><th>Class</th><th>Required</th><th>Available</th><th>Status</th></tr>
          </thead>
          <tbody>
            {availability.rows.map((r) => (
              <tr key={r.setId}>
                <td>{r.subjectName}</td>
                <td>{r.levelName}</td>
                <td>{r.required}</td>
                <td className={r.ready ? '' : 'short'}>{r.available}</td>
                <td>
                  {r.alreadyComposed ? <span className="pill pill--published">Paper composed</span>
                    : r.ready ? <span className="pill pill--approved">Ready</span>
                      : <span className="pill pill--returned">Not enough questions</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ── Step 2: composition ───────────────────────────────────────────── */}
      <h2 className="sub-head">Compose papers</h2>
      <p className="muted" style={{ marginTop: -6 }}>
        A paper is created for every subject and class with enough approved
        questions. A subject short of questions is never composed silently — it is
        named above and skipped. Composing again never duplicates a paper.
      </p>
      <form action={compose}>
        <button type="submit">Compose papers</button>
      </form>

      {/* ── Step 3: scheduling ────────────────────────────────────────────── */}
      {papers.length > 0 && !isPractice ? (
        <>
          <h2 className="sub-head">Schedule examination</h2>
          <p className="muted" style={{ marginTop: -6 }}>
            Papers are placed on school days between the first and last day of
            sitting, into up to four slots a day (two by default: morning and
            afternoon). One class never sits two papers at once. These dates
            become the sitting window the system enforces: no student can start
            before it opens or after it closes.
          </p>
          <form action={schedule} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="startsOn">First day of sitting</label>
              <input id="startsOn" name="startsOn" type="date" required
                     defaultValue={series.sittingOpensAt ? series.sittingOpensAt.toISOString().slice(0, 10) : ''} />
            </div>
            <div>
              <label htmlFor="endsOn">Last day of sitting</label>
              <input id="endsOn" name="endsOn" type="date"
                     defaultValue={series.sittingClosesAt ? series.sittingClosesAt.toISOString().slice( 0, 10) : ''} />
            </div>
            <div>
              <label htmlFor="slotsPerDay">Slots per day</label>
              <input id="slotsPerDay" name="slotsPerDay" type="number" min="1" max="4" defaultValue={2} />
            </div>
            <button type="submit">Schedule papers</button>
          </form>
        </>
      ) : null}

      {/* ── Step 4: timetable review ───────────────────────────────────────── */}
      {papers.length > 0 ? (
        <>
          <h2 className="sub-head">{isPractice ? 'Papers' : 'Timetable'}</h2>
          {unscheduled > 0 && !isPractice ? (
            <p className="error">
              {unscheduled} paper{unscheduled === 1 ? '' : 's'} without a timetable slot.
              They cannot be published until they are scheduled.
            </p>
          ) : null}
          <table className="tbl">
            <thead>
              <tr>
                {isPractice ? null : <><th>Date</th><th>Start</th><th>End</th></>}
                <th>Subject</th><th>Class</th><th>Questions</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {papers.map((p) => (
                <tr key={p.id}>
                  {isPractice ? null : <><td>{fmtDay(p.scheduledAt)}</td><td>{fmtTime(p.scheduledAt)}</td><td>{fmtTime(p.scheduledAt ? addMinutes(p.scheduledAt, p.durationSeconds / 60) : null)}</td></>}
                  <td>{p.subjectName}</td>
                  <td>{p.levelName ?? '—'}</td>
                  <td>{p.questionCount}</td>
                  <td>
                    {p.status === 'published' ? <span className="pill pill--published">Published</span>
                      : p.scheduledAt || isPractice ? <span className="pill pill--approved">{p.status === 'draft' ? 'Ready to publish' : 'Draft'}</span>
                        : <span className="pill pill--returned">Unscheduled paper</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted">No papers yet. Compose first.</p>
      )}

      {/* ── Step 5: publish ────────────────────────────────────────────────── */}
      {papers.length > 0 ? (
        <>
          <h2 className="sub-head">Publish</h2>
          <p className="muted" style={{ marginTop: -6 }}>
            Publishing releases every paper to the students registered for the
            subject{isPractice ? ' immediately' : ' on their timetable'}. Before you
            continue, confirm:
          </p>
          <ul className="bullets">
            <li>{papers.length} paper{papers.length === 1 ? '' : 's'} composed{shortages.length > 0 ? ` — ${shortages.length} subject(s) short of questions were skipped and will NOT be sat` : ' — every subject with approved questions'}</li>
            {!isPractice ? <li>{unscheduled === 0 ? 'Every paper has a timetable slot' : `${unscheduled} paper(s) unscheduled — publishing is blocked`}</li> : null}
            {!isPractice ? <li>{series.sittingOpensAt ? `Sitting window: ${fmtDay(series.sittingOpensAt)} – ${fmtDay(series.sittingClosesAt)}` : 'No sitting window — publishing is blocked'}</li> : null}
          </ul>
          <form action={publish}>
            {/* The server action re-checks readiness too — this only stops the
                click that could not succeed. */}
            <button type="submit" disabled={!readyToPublish}>
              {published ? 'Publish new papers' : 'Publish examination'}
            </button>
            {!readyToPublish ? (
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                Resolve the items above — publishing is blocked until the
                examination is complete.
              </p>
            ) : null}
          </form>
        </>
      ) : null}
    </>
  );
}
