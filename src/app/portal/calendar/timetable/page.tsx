import '../../school-table.css';
import '../calendar.css';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { loadTimetable, saveLesson, removeLesson, savePeriods, setTimetablePublished, type LessonView } from '@/lib/calendar/timetable-service';
import { CalendarError } from '@/lib/calendar/service';
import { WEEKDAY_NAMES } from '@/lib/calendar/timetable-rules';

export const dynamic = 'force-dynamic';

const DAYS = [1, 2, 3, 4, 5];

/**
 * Class teaching timetable. A class teacher edits THEIR class; the principal,
 * vice principal and exam officer edit any. The page only decides what to draw:
 * every action below re-checks the person's right on the server.
 */
export default async function ClassTimetablePage({ searchParams }: { searchParams: Promise<{ classId?: string; error?: string; ok?: string; edit?: string }> }) {
  const actor = await requireSchoolSession();
  const q = await searchParams;
  const classId = Number(q.classId) || undefined;
  const view = await loadTimetable(actor, undefined, classId);
  const back = (extra = '') => `/portal/calendar/timetable?classId=${view.classId ?? ''}${extra}`;

  async function addLesson(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const cid = Number(fd.get('classId'));
    const target = `/portal/calendar/timetable?classId=${cid}`;
    let message = '';
    try {
      const v = await loadTimetable(a, undefined, cid);
      const sessionId = Number(fd.get('sessionId'));
      const r = await saveLesson(a, sessionId, {
        classId: cid, periodId: Number(fd.get('periodId')), weekday: Number(fd.get('weekday')), subjectId: Number(fd.get('subjectId')),
        staffId: Number(fd.get('staffId')) || null, room: String(fd.get('room') ?? ''),
      }, Number(fd.get('lessonId')) || undefined);
      void v;
      if (!r.ok) message = r.errors.join(' ');
    } catch (e) { message = e instanceof CalendarError ? e.message : 'The lesson could not be saved.'; }
    redirect(message ? `${target}&error=${encodeURIComponent(message)}` : `${target}&ok=Lesson+saved`);
  }

  async function dropLesson(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const cid = Number(fd.get('classId'));
    let message = '';
    try { await removeLesson(a, Number(fd.get('lessonId'))); } catch (e) { message = e instanceof CalendarError ? e.message : 'The lesson could not be removed.'; }
    redirect(`/portal/calendar/timetable?classId=${cid}${message ? `&error=${encodeURIComponent(message)}` : '&ok=Lesson+removed'}`);
  }

  async function publish(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const cid = Number(fd.get('classId')), on = fd.get('publish') === '1';
    let message = '', ok = on ? 'Timetable+published' : 'Timetable+returned+to+draft';
    try { const r = await setTimetablePublished(a, Number(fd.get('sessionId')), cid, on); if (r.notified) ok = `Timetable+published+and+${r.notified}+people+told`; } catch (e) { message = e instanceof CalendarError ? e.message : 'That could not be done.'; }
    redirect(`/portal/calendar/timetable?classId=${cid}${message ? `&error=${encodeURIComponent(message)}` : `&ok=${ok}`}`);
  }

  async function savePeriodsAction(fd: FormData) {
    'use server';
    const a = await requireSchoolSession();
    const names = fd.getAll('name').map(String), starts = fd.getAll('start').map(String), ends = fd.getAll('end').map(String), breaks = new Set(fd.getAll('isBreak').map(String));
    const rows = names.map((name, i) => ({ name, startTime: starts[i] ?? '', endTime: ends[i] ?? '', isBreak: breaks.has(String(i)) })).filter((r) => r.name.trim() || r.startTime || r.endTime);
    let message = '';
    try { const r = await savePeriods(a, rows, fd.get('confirm') === '1'); if (!r.ok) message = r.errors.join(' '); } catch (e) { message = e instanceof CalendarError ? e.message : 'The periods could not be saved.'; }
    redirect(`/portal/calendar/timetable?classId=${Number(fd.get('classId')) || ''}${message ? `&error=${encodeURIComponent(message)}&edit=periods` : '&ok=Periods+saved'}`);
  }

  const sessionId = (await import('@/lib/calendar/service').then((m) => m.loadCalendar(actor))).session?.id ?? 0;
  const cell = (day: number, periodId: number): LessonView | undefined => view.lessons.find((l) => l.weekday === day && l.periodId === periodId);
  const editing = view.canEdit;
  const pickedLesson = Number((q as { lesson?: string }).lesson) || 0;
  const selected = view.lessons.find((l) => l.id === pickedLesson);

  return (
    <div className="portal-page cal-page">
      <div className="cal-head">
        <div>
          <h1 className="page-title">Class timetable</h1>
          <p className="muted">{editing ? 'Set the weekly teaching timetable for this class.' : 'The weekly teaching timetable.'}</p>
        </div>
        <nav className="cal-tabs" aria-label="Calendar sections">
          <Link href="/portal/calendar" className="sa-btn sa-btn--ghost">Academic calendar</Link>
          <span className="sa-btn" aria-current="page">Class timetable</span>
        </nav>
      </div>

      {q.error ? <p className="alert" role="alert">{q.error}</p> : null}
      {q.ok ? <p className="ok" role="status">{q.ok}</p> : null}

      {view.classes.length === 0 ? (
        <p className="muted empty-state">There is no class timetable to show yet.</p>
      ) : (
        <>
          <form className="sa-toolbar" action="/portal/calendar/timetable" method="get">
            <label>Class
              <select name="classId" defaultValue={view.classId ?? ''}>
                {view.classes.map((c) => <option key={c.id} value={c.id}>{c.name}{c.canEdit ? '' : ' (view only)'}</option>)}
              </select>
            </label>
            <button className="sa-btn" type="submit">Show</button>
          </form>

          {view.periods.length === 0 ? (
            <div className="card sa-card"><p className="muted">{view.canEditPeriods ? 'Set the school day first: add the periods and breaks below.' : 'The school has not set its periods yet.'}</p></div>
          ) : view.lessons.length === 0 && !editing ? (
            <p className="muted empty-state">{view.className}&rsquo;s timetable has not been published yet.</p>
          ) : (
            <div className="card sa-card">
              <div className="cal-row">
                <h2>{view.className}</h2>
                {editing ? (
                  <form action={publish}>
                    <input type="hidden" name="classId" value={view.classId ?? ''} /><input type="hidden" name="sessionId" value={sessionId} />
                    <input type="hidden" name="publish" value={view.published ? '0' : '1'} />
                    <span className={`cal-badge ${view.published ? 'cal-badge--on' : ''}`}>{view.published ? 'Published' : 'Draft'}</span>{' '}
                    <button className="sa-btn" type="submit">{view.published ? 'Return to draft' : 'Publish to students and parents'}</button>
                  </form>
                ) : null}
              </div>
              <div className="sa-table-wrap">
                <table className="sa-table tt-grid">
                  <thead><tr><th>Period</th>{DAYS.map((d) => <th key={d}>{WEEKDAY_NAMES[d]}</th>)}</tr></thead>
                  <tbody>
                    {view.periods.map((p) => (
                      <tr key={p.id} className={p.isBreak ? 'tt-break' : ''}>
                        <th scope="row">{p.name}<br /><span className="muted">{p.startTime} to {p.endTime}</span></th>
                        {p.isBreak ? <td colSpan={DAYS.length} className="muted tt-break-cell">Break</td> : DAYS.map((d) => {
                          const l = cell(d, p.id);
                          return (
                            <td key={d} className={l ? 'tt-filled' : 'tt-empty'}>
                              {l ? (
                                <>
                                  <strong>{l.subjectName}</strong>
                                  {l.staffName ? <div className="muted">{l.staffName}</div> : editing ? <div className="muted tt-noteacher">No teacher yet</div> : null}
                                  {l.room ? <div className="muted">{l.room}</div> : null}
                                  {editing ? (
                                    <div className="tt-actions">
                                      <Link href={back(`&lesson=${l.id}&day=${d}&period=${p.id}`)} className="tt-link">Change</Link>
                                      <form action={dropLesson}><input type="hidden" name="classId" value={view.classId ?? ''} /><input type="hidden" name="lessonId" value={l.id} /><button className="tt-link" type="submit">Remove</button></form>
                                    </div>
                                  ) : null}
                                </>
                              ) : editing ? <Link href={back(`&day=${d}&period=${p.id}`)} className="tt-link">Add</Link> : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {editing && (q as { day?: string }).day ? (
            <form className="card sa-card tt-form" action={addLesson}>
              <h3>{selected ? 'Change lesson' : 'Add a lesson'}</h3>
              <input type="hidden" name="classId" value={view.classId ?? ''} /><input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="lessonId" value={selected?.id ?? ''} />
              <label>Day<select name="weekday" defaultValue={Number((q as { day?: string }).day)}>{DAYS.map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}</select></label>
              <label>Period<select name="periodId" defaultValue={Number((q as { period?: string }).period)}>{view.periods.filter((p) => !p.isBreak).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.startTime})</option>)}</select></label>
              <label>Subject<select name="subjectId" defaultValue={selected?.subjectId ?? ''} required>
                <option value="" disabled>Choose a subject</option>
                {view.choices.map((c) => <option key={c.subjectId} value={c.subjectId}>{c.subjectName}</option>)}
              </select></label>
              <label>Teacher<select name="staffId" defaultValue={selected?.staffId ?? ''}>
                <option value="">No teacher yet</option>
                {view.choices.flatMap((c) => c.teachers.map((t) => <option key={`${c.subjectId}-${t.staffId}`} value={t.staffId}>{t.name} ({c.subjectName})</option>))}
              </select></label>
              <label>Room<input name="room" maxLength={60} defaultValue={selected?.room ?? ''} placeholder="Optional" /></label>
              <div className="tt-form-actions"><button className="sa-btn" type="submit">Save lesson</button> <Link href={back()} className="sa-btn sa-btn--ghost">Cancel</Link></div>
              <p className="muted">A lesson with a teacher also appears on that teacher&rsquo;s dashboard.</p>
              {view.choices.length === 0 ? <p className="muted">No subjects have teachers in this class yet. Assign teachers under Staff first.</p> : null}
            </form>
          ) : null}
        </>
      )}

      {view.canEditPeriods ? (
        <details className="card sa-card" open={q.edit === 'periods' || view.periods.length === 0}>
          <summary><strong>School periods and breaks</strong></summary>
          <p className="muted">These apply to every class. Rename or re-time a period to keep its lessons; removing one deletes the lessons placed in it.</p>
          <form action={savePeriodsAction} className="tt-periods">
            <input type="hidden" name="classId" value={view.classId ?? ''} />
            {[...view.periods, ...Array.from({ length: 2 }, (_, i) => ({ id: -i - 1, name: '', position: 0, startTime: '', endTime: '', isBreak: false }))].map((p, i) => (
              <div className="tt-period-row" key={p.id}>
                <input name="name" defaultValue={p.name} placeholder="Period name" maxLength={60} aria-label="Period name" />
                <input name="start" type="time" defaultValue={p.startTime} aria-label="Starts" />
                <input name="end" type="time" defaultValue={p.endTime} aria-label="Ends" />
                <label className="tt-check"><input type="checkbox" name="isBreak" value={i} defaultChecked={p.isBreak} /> Break</label>
              </div>
            ))}
            <label className="tt-check"><input type="checkbox" name="confirm" value="1" /> I understand removing a period deletes its lessons</label>
            <button className="sa-btn" type="submit">Save periods</button>
          </form>
        </details>
      ) : null}
    </div>
  );
}
