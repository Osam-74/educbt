import '../school-table.css';
import './calendar.css';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { loadCalendar, saveEvent, cancelEvent, deleteEvent, setCalendarState, setTermDates, CalendarError } from '@/lib/calendar/service';
import { occurrences, buildPeriods, stateOf, progress, nextResumption, daysToNextExam, dayStatus, isNonInstructional, type CalEvent } from '@/lib/calendar/engine';
import { addDays, addMonths, eachDay, startOfWeek, weekday, isDateStr } from '@/lib/calendar/dates';
import { CATEGORIES, AUDIENCES } from '@/lib/calendar/validate';
import { forSchool, schema } from '@/db';
import { asc, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const CATEGORY_LABEL: Record<string, string> = {
  academic: 'Academic', examination: 'Examination', school_event: 'School event', public_holiday: 'Public holiday',
  school_holiday: 'School holiday', mid_term_break: 'Mid-term break', non_instructional: 'Non-instructional day', administrative: 'Administrative', deadline: 'Deadline', ceremonial: 'Ceremony',
};
const AUDIENCE_LABEL: Record<string, string> = { everyone: 'Everyone', staff: 'Staff only', teachers: 'Teachers', students: 'Students', guardians: 'Parents and guardians', classes: 'Chosen classes' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const niceDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const range = (e: CalEvent) => (e.startsOn === e.endsOn ? niceDate(e.startsOn) : `${niceDate(e.startsOn)} to ${niceDate(e.endsOn)}`);
const when = (e: CalEvent) => (e.allDay || !e.startTime ? 'All day' : e.endTime ? `${e.startTime} to ${e.endTime}` : e.startTime);

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await requireSchoolSession();
  const q = await searchParams;
  const view = await loadCalendar(actor, Number(q.session) || undefined);
  const sessionId = view.session?.id ?? 0;
  const mode = q.view === 'list' ? 'list' : 'month';
  const here = (extra: Record<string, string | undefined> = {}) => {
    const p = new URLSearchParams();
    const all = { session: q.session, view: q.view, month: q.month, category: q.category, ...extra };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    return `/portal/calendar${p.toString() ? `?${p}` : ''}`;
  };

  const classes = view.canManage ? await forSchool(actor.schoolId, (tx) => tx.select({ id: schema.classes.id, name: schema.classes.displayName }).from(schema.classes).where(eq(schema.classes.schoolId, actor.schoolId)).orderBy(asc(schema.classes.displayName))) : [];

  async function save(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const id = Number(fd.get('id')) || undefined;
    const raw: Record<string, unknown> = {
      title: fd.get('title'), description: fd.get('description'), category: fd.get('category'), status: fd.get('status') || 'scheduled',
      startsOn: fd.get('startsOn'), endsOn: fd.get('endsOn') || fd.get('startsOn'), allDay: fd.get('allDay') === 'on', startTime: fd.get('startTime'), endTime: fd.get('endTime'),
      venue: fd.get('venue'), audience: fd.get('audience'), staffGroup: fd.get('staffGroup'), attachmentUrl: fd.get('attachmentUrl'),
      classIds: fd.getAll('classIds').map(Number), repeat: fd.get('repeat') || 'none', repeatEvery: fd.get('repeatEvery') || 1, repeatUntil: fd.get('repeatUntil'),
      remindDaysBefore: fd.get('remindDaysBefore') || 0, published: fd.get('published') === 'on', overrideNote: fd.get('overrideNote'),
    };
    const sid = Number(fd.get('sessionId'));
    let message = '', warn = '';
    try {
      const r = await saveEvent(a, sid, raw, id, fd.get('override') === '1');
      if (!r.ok) { if (r.needsOverride) warn = r.warnings?.map((w) => w.message).join(' ') ?? ''; message = r.errors.join(' '); }
    } catch (e) { message = e instanceof CalendarError ? e.message : 'The event could not be saved.'; }
    const back = `/portal/calendar?session=${sid}`;
    if (warn) redirect(`${back}&warn=${encodeURIComponent(warn)}&edit=${id ?? 'new'}`);
    redirect(message ? `${back}&error=${encodeURIComponent(message)}&edit=${id ?? 'new'}` : `${back}&ok=Event+saved`);
  }
  async function act(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const id = Number(fd.get('id')), what = String(fd.get('what')), sid = Number(fd.get('sessionId'));
    let message = '', ok = 'Done';
    try {
      if (what === 'cancel') { await cancelEvent(a, id); ok = 'Event+cancelled'; }
      else if (what === 'delete') { await deleteEvent(a, id); ok = 'Event+deleted'; }
      else if (what === 'publish' || what === 'draft' || what === 'archive') {
        const r = await setCalendarState(a, sid, what === 'publish' ? 'published' : what === 'archive' ? 'archived' : 'draft');
        ok = what === 'publish' ? (r.notified ? `Calendar+published+and+${r.notified}+people+told` : 'Calendar+published') : what === 'archive' ? 'Calendar+archived' : 'Calendar+returned+to+draft';
      }
    } catch (e) { message = e instanceof CalendarError ? e.message : 'That could not be done.'; }
    redirect(`/portal/calendar?session=${sid}${message ? `&error=${encodeURIComponent(message)}` : `&ok=${ok}`}`);
  }

  async function saveTerms(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const sid = Number(fd.get('sessionId')), termId = Number(fd.get('termId'));
    let message = '';
    try { await setTermDates(a, sid, { termId, startsOn: String(fd.get('resumesOn') ?? ''), endsOn: String(fd.get('closesOn') ?? '') }); }
    catch (e) { message = e instanceof CalendarError ? e.message : 'The term dates could not be saved.'; }
    redirect(`/portal/calendar?session=${sid}${message ? `&error=${encodeURIComponent(message)}` : '&ok=Term+dates+saved'}`);
  }

  if (!view.session) {
    return <div className="portal-page cal-page"><h1 className="page-title">Academic calendar</h1><p className="muted empty-state">No academic session has been set up yet.</p></div>;
  }

  // Month being shown: ?month=YYYY-MM, else the month of today (or the session start if today is outside it).
  const wanted = q.month && /^\d{4}-\d{2}$/.test(q.month) ? `${q.month}-01` : null;
  const first = wanted && isDateStr(wanted) ? wanted : `${view.today.slice(0, 7)}-01`;
  const gridStart = startOfWeek(first), gridEnd = addDays(startOfWeek(addDays(addMonths(first, 1), -1)), 6);
  const filtered = view.events.filter((e) => !q.category || e.category === q.category);
  const inGrid = filtered.flatMap((e) => occurrences(e, gridStart, gridEnd));

  const prog = progress(view.terms, view.events, view.today);
  const periods = buildPeriods(view.terms, []);
  const resume = nextResumption(view.terms, view.today), exam = daysToNextExam(view.events, view.today);
  const editing = q.edit && view.canManage ? (q.edit === 'new' ? null : view.events.find((e) => e.source === 'event' && e.id === Number(q.edit)) ?? null) : undefined;
  const sessionEnd = view.session.endsOn;

  // List view: everything from the first of the month for a year, in date order.
  const listFrom = first, listTo = addDays(addMonths(first, 12), -1);
  const listed = filtered.flatMap((e) => occurrences(e, listFrom, listTo)).sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.title.localeCompare(b.title));
  const pill = (e: CalEvent) => `cal-pill cal-pill--${e.category}${e.status === 'cancelled' ? ' cal-pill--cancelled' : ''}`;

  return (
    <div className="portal-page cal-page">
      <div className="cal-head">
        <div>
          <h1 className="page-title">Academic calendar</h1>
          <p className="muted">{view.session.title}{view.state !== 'published' && view.canManage ? ` · ${view.state === 'archived' ? 'Archived' : 'Draft, not yet visible to staff, students and parents'}` : ''}</p>
        </div>
        <nav className="cal-tabs" aria-label="Calendar sections">
          <span className="sa-btn" aria-current="page">Academic calendar</span>
          <Link href="/portal/calendar/timetable" className="sa-btn sa-btn--ghost">Class timetable</Link>
        </nav>
      </div>

      {q.error ? <p className="alert" role="alert">{q.error}</p> : null}
      {q.warn ? (
        <div className="alert" role="alert">
          <strong>Check this before saving.</strong> {q.warn}
          {view.canPublish ? ' If it is intended, save again with the box ticked and a reason.' : ' Ask the principal or vice principal to save it, or change the date.'}
        </div>
      ) : null}
      {q.ok ? <p className="ok" role="status">{q.ok}</p> : null}

      <div className="cal-stats">
        <div className="card sa-card cal-stat"><span className="muted">Teaching week</span><strong>{prog.currentWeek ? `Week ${prog.currentWeek}` : 'Not in session'}</strong><span className="muted">{prog.doneWeeks} of {prog.totalWeeks} weeks done</span></div>
        <div className="card sa-card cal-stat"><span className="muted">School days</span><strong>{prog.remainingDays} left</strong><span className="muted">{prog.doneDays} of {prog.totalDays} done · {prog.percent}%</span></div>
        <div className="card sa-card cal-stat"><span className="muted">Next resumption</span><strong>{resume ? `${resume.inDays} day${resume.inDays === 1 ? '' : 's'}` : 'None set'}</strong><span className="muted">{resume ? `${resume.title}, ${niceDate(resume.on)}` : 'No later term has dates'}</span></div>
        <div className="card sa-card cal-stat"><span className="muted">Next examination</span><strong>{exam ? (exam.inDays === 0 ? 'Today' : `${exam.inDays} day${exam.inDays === 1 ? '' : 's'}`) : 'None planned'}</strong><span className="muted">{exam ? `${exam.title}, ${niceDate(exam.on)}` : 'No upcoming examination'}</span></div>
      </div>

      <div className="card sa-card">
        <h2>Terms</h2>
        {periods.length === 0 ? <p className="muted">No term has dates yet. {view.canManage ? 'Set them under School Settings.' : ''}</p> : (
          <ol className="cal-periods">
            {periods.map((p) => { const s = stateOf(p.startsOn, p.endsOn, view.today); return (
              <li key={`${p.kind}-${p.startsOn}`} className={`cal-period cal-period--${p.kind}`}>
                <div><strong>{p.label}</strong><br /><span className="muted">{niceDate(p.startsOn)} to {niceDate(p.endsOn)}</span></div>
                <span className={`cal-badge ${s === 'ongoing' ? 'cal-badge--on' : ''}`}>{s === 'ongoing' ? 'Ongoing' : s === 'completed' ? 'Completed' : 'Upcoming'}</span>
              </li>); })}
          </ol>
        )}
        {view.canManage && view.terms.length > 0 ? (
          <details className="cal-termedit" open={q.terms === '1' || undefined}>
            <summary>Change term dates</summary>
            <p className="muted">The resumption and closing date of each term. School days, weekends and the progress above all follow these dates.</p>
            {view.terms.map((t) => (
              <form key={t.id} action={saveTerms} className="cal-termform" data-term={t.id}>
                <input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="termId" value={t.id} />
                <strong>{t.title}</strong>
                <label>Resumes<input type="date" name="resumesOn" defaultValue={t.startsOn ?? ''} required /></label>
                <label>Closes<input type="date" name="closesOn" defaultValue={t.endsOn ?? ''} required /></label>
                <button className="sa-btn" type="submit">Save dates</button>
              </form>
            ))}
          </details>
        ) : null}
      </div>

      <div className="card sa-card">
        <div className="cal-row">
          <div className="cal-nav">
            <Link className="sa-btn sa-btn--ghost" href={here({ month: addMonths(first, -1).slice(0, 7) })}>Previous</Link>
            <h2>{MONTHS[Number(first.slice(5, 7)) - 1]} {first.slice(0, 4)}</h2>
            <Link className="sa-btn sa-btn--ghost" href={here({ month: addMonths(first, 1).slice(0, 7) })}>Next</Link>
          </div>
          <div className="cal-tabs">
            <Link className={`sa-btn ${mode === 'month' ? '' : 'sa-btn--ghost'}`} href={here({ view: 'month' })}>Month</Link>
            <Link className={`sa-btn ${mode === 'list' ? '' : 'sa-btn--ghost'}`} href={here({ view: 'list' })}>List</Link>
            {view.canManage ? <Link className="sa-btn" href={here({ edit: 'new' })}>Add event</Link> : null}
          </div>
        </div>
        <form className="sa-toolbar" method="get" action="/portal/calendar">
          <input type="hidden" name="view" value={mode} /><input type="hidden" name="month" value={first.slice(0, 7)} />
          <label>Show<select name="category" defaultValue={q.category ?? ''}><option value="">Everything</option>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
          <button className="sa-btn" type="submit">Filter</button>
        </form>

        {mode === 'month' ? (
          <div className="cal-grid" role="grid" aria-label={`${MONTHS[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="cal-dow" role="columnheader">{d}</div>)}
            {eachDay(gridStart, gridEnd).map((d) => {
              const todays = inGrid.filter((e) => e.startsOn <= d && d <= e.endsOn);
              const out = d.slice(0, 7) !== first.slice(0, 7), wk = weekday(d) === 0 || weekday(d) === 6;
              const ds = dayStatus(d, view.terms, view.events);
              return (
                <div key={d} role="gridcell" className={`cal-cell${out ? ' cal-cell--out' : ''}${wk ? ' cal-cell--wk' : ''}${ds.state === 'off' ? ' cal-cell--off' : ''}${d === view.today ? ' cal-cell--today' : ''}`} data-day={d} data-state={ds.state}>
                  <span className="cal-day">{Number(d.slice(8))}</span>
                  {ds.state !== 'none' ? <span className={`cal-state cal-state--${ds.state}`}>{ds.state === 'school_day' ? 'School day' : ds.state === 'weekend' ? 'Weekend' : ds.by ? CATEGORY_LABEL[ds.by.category] : 'Day off'}</span> : null}
                  {todays.slice(0, 3).map((e) => <span key={e.key} className={pill(e)} title={`${e.title} · ${CATEGORY_LABEL[e.category]}`}>{e.title}</span>)}
                  {todays.length > 3 ? <span className="muted cal-more">+{todays.length - 3} more</span> : null}
                </div>
              );
            })}
          </div>
        ) : listed.length === 0 ? <p className="muted empty-state">Nothing is scheduled in this period.</p> : (
          <ul className="cal-list">
            {listed.map((e) => (
              <li key={e.key} className="cal-item">
                <div className="cal-item__when"><strong>{range(e)}</strong><br /><span className="muted">{when(e)}</span></div>
                <div className="cal-item__what">
                  <span className={pill(e)}>{e.title}</span> <span className="muted">{CATEGORY_LABEL[e.category]}{e.venue ? ` · ${e.venue}` : ''}{e.status === 'cancelled' ? ' · Cancelled' : ''}{e.status === 'completed' ? ' · Completed' : ''}</span>
                  {e.description ? <p>{e.description}</p> : null}
                  {view.conflicts[e.key.split('@')[0]!]?.map((c) => <p key={c.kind + c.message} className="cal-warn">{c.message}</p>)}
                  {e.manageHref ? <Link className="tt-link" href={e.manageHref}>Open in Examinations</Link> : null}
                  {view.canManage && e.source === 'event' ? (
                    <div className="tt-actions">
                      <Link className="tt-link" href={here({ edit: String(e.id) })}>Edit</Link>
                      {e.status !== 'cancelled' ? <form action={act}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="what" value="cancel" /><button className="tt-link" type="submit">{isNonInstructional(e.category) ? 'Restore default' : 'Cancel'}</button></form> : null}
                      <form action={act}><input type="hidden" name="id" value={e.id} /><input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="what" value="delete" /><button className="tt-link" type="submit">Delete</button></form>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="muted cal-legend">Times are in {view.timeZone}.{sessionEnd ? ` The session ends ${niceDate(sessionEnd)}.` : ''}</p>
      </div>

      {view.canPublish ? (
        <div className="card sa-card cal-row">
          <div><strong>{view.state === 'published' ? 'Published' : view.state === 'archived' ? 'Archived' : 'Draft'}</strong><p className="muted">{view.state === 'published' ? 'Staff, students and parents can see the events meant for them.' : 'Only the principal, vice principal and exam officer can see it.'}</p></div>
          <div className="cal-tabs">
            {view.state !== 'published' ? <form action={act}><input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="what" value="publish" /><button className="sa-btn" type="submit">Publish calendar</button></form> : null}
            {view.state === 'published' ? <form action={act}><input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="what" value="draft" /><button className="sa-btn sa-btn--ghost" type="submit">Return to draft</button></form> : null}
            {view.state !== 'archived' ? <form action={act}><input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="what" value="archive" /><button className="sa-btn sa-btn--ghost" type="submit">Archive</button></form> : null}
          </div>
        </div>
      ) : null}

      {view.canManage && editing !== undefined ? (
        <form className="card sa-card tt-form" action={save}>
          <h3>{editing ? 'Edit event' : 'Add an event'}</h3>
          <input type="hidden" name="sessionId" value={sessionId} /><input type="hidden" name="id" value={editing?.id ?? ''} />
          <label>Title<input name="title" required maxLength={191} defaultValue={editing?.title ?? ''} /></label>
          <label>Category<select name="category" defaultValue={editing?.category ?? 'school_event'}>{CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}</select></label>
          <label>Starts<input name="startsOn" type="date" required defaultValue={editing?.startsOn ?? ''} /></label>
          <label>Ends<input name="endsOn" type="date" defaultValue={editing?.endsOn ?? ''} /></label>
          <label className="tt-check"><input type="checkbox" name="allDay" defaultChecked={editing ? editing.allDay : true} /> All day</label>
          <label>From<input name="startTime" type="time" defaultValue={editing?.startTime ?? ''} /></label>
          <label>To<input name="endTime" type="time" defaultValue={editing?.endTime ?? ''} /></label>
          <label>Venue<input name="venue" maxLength={191} defaultValue={editing?.venue ?? ''} /></label>
          <label>Who is it for<select name="audience" defaultValue={editing?.audience ?? 'everyone'}>{AUDIENCES.map((a) => <option key={a} value={a}>{AUDIENCE_LABEL[a]}</option>)}</select></label>
          <label>Classes (when "Chosen classes")<select name="classIds" multiple size={4} defaultValue={(editing?.classIds ?? []).map(String)}>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Repeats<select name="repeat" defaultValue={editing?.repeat ?? 'none'}><option value="none">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
          <label>Every<input name="repeatEvery" type="number" min={1} max={52} defaultValue={editing?.repeatEvery ?? 1} /></label>
          <label>Repeat until<input name="repeatUntil" type="date" defaultValue={editing?.repeatUntil ?? ''} /></label>
          <label>Remind (days before)<input name="remindDaysBefore" type="number" min={0} max={60} defaultValue={0} /></label>
          <label>Status<select name="status" defaultValue={editing?.status ?? 'scheduled'}><option value="draft">Draft</option><option value="scheduled">Scheduled</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></label>
          <label className="tt-check"><input type="checkbox" name="published" defaultChecked={editing ? editing.published : true} /> Show on the published calendar</label>
          <label className="cal-wide">Details<textarea name="description" rows={3} maxLength={4000} defaultValue={editing?.description ?? ''} /></label>
          <label className="cal-wide">Attachment link (https)<input name="attachmentUrl" maxLength={500} /></label>
          {q.warn && view.canPublish ? (<>
            <label className="tt-check cal-wide"><input type="checkbox" name="override" value="1" /> This is intended, save it anyway</label>
            <label className="cal-wide">Why<input name="overrideNote" maxLength={300} placeholder="A short reason, kept on record" /></label>
          </>) : null}
          <div className="tt-form-actions"><button className="sa-btn" type="submit">Save event</button> <Link href={here()} className="sa-btn sa-btn--ghost">Cancel</Link></div>
        </form>
      ) : null}
    </div>
  );
}
