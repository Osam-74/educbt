import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { upcomingForViewer } from '@/lib/calendar/service';
import { loadTimetable, myTeachingWeek } from '@/lib/calendar/timetable-service';
import { instructionalLabel } from '@/lib/calendar/glance';
import { PortalIcon } from './PortalShell';

const niceDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * "Today and coming up" for the dashboards: today's lessons and the next few calendar events.
 * Self-contained so each dashboard needs one line to include it. Everything it shows has already been
 * restricted by the same rules as the calendar and timetable pages, and it renders nothing at all
 * for a school that has neither lessons nor events, so a new school's dashboard stays clean.
 */
export default async function CalendarGlance() {
  const actor = await requireSchoolSession();
  const [{ events, today, timeZone }, tt, week] = await Promise.all([
    upcomingForViewer(actor, 5, 30),
    ['student', 'parent'].includes(actor.role) || actor.role === 'teacher' ? loadTimetable(actor) : Promise.resolve(null),
    actor.staffId ? myTeachingWeek(actor) : Promise.resolve(null),
  ]);
  const wd = new Date(`${today}T00:00:00Z`).getUTCDay(), weekday = wd === 0 ? 7 : wd;
  const periodName = (id: number, list: Array<{ id: number; name: string; startTime: string; endTime: string }>) => list.find((p) => p.id === id);

  // A teacher sees their own lessons across classes; a student or parent sees their class's lessons for today.
  const mine = week && actor.staffId && week.lessons.length > 0
    ? week.lessons.filter((l) => l.weekday === weekday).sort((a, b) => (periodName(a.periodId, week.periods)?.startTime ?? '').localeCompare(periodName(b.periodId, week.periods)?.startTime ?? '')).map((l) => ({ id: l.id, when: periodName(l.periodId, week.periods), title: l.subjectName, sub: l.className, room: l.room }))
    : tt && ['student', 'parent'].includes(actor.role) ? tt.todaysLessons.map((l) => ({ id: l.id, when: periodName(l.periodId, tt.periods), title: l.subjectName, sub: l.staffName ?? '', room: l.room })) : [];
  const haveTimetable = (week && week.lessons.length > 0) || (tt && tt.lessons.length > 0);
  const note = instructionalLabel({ haveTimetable: !!haveTimetable, teachingToday: tt ? tt.teachingToday : true, weekday, lessonCount: mine.length });

  if (!events.length && !haveTimetable) return null;
  return (
    <section className="sd-panel sd-panel--wide" aria-label="Today and coming up">
      <header><h2><PortalIcon name="timetable" />Today and coming up</h2><Link href="/portal/calendar" className="sd-term">Open calendar</Link></header>
      {haveTimetable ? (
        <div>
          <h3 className="sd-sub">Today&rsquo;s lessons, {niceDay(today)}</h3>
          {mine.length ? (
            <ul className="sd-list">
              {mine.map((l) => <li key={l.id}><strong>{l.when ? `${l.when.startTime} to ${l.when.endTime}` : ''}</strong> {l.title}{l.sub ? <span className="muted"> · {l.sub}</span> : null}{l.room ? <span className="muted"> · {l.room}</span> : null}</li>)}
            </ul>
          ) : <p className="muted">{note}</p>}
        </div>
      ) : null}
      {events.length ? (
        <div>
          <h3 className="sd-sub">Coming up</h3>
          <ul className="sd-list">
            {events.map((e) => (
              <li key={e.key}><strong>{e.ongoing ? 'On now' : e.inDays === 0 ? 'Today' : e.inDays === 1 ? 'Tomorrow' : `In ${e.inDays} days`}</strong> {e.title}
                <span className="muted"> · {e.startsOn === e.endsOn ? niceDay(e.startsOn) : `${niceDay(e.startsOn)} to ${niceDay(e.endsOn)}`}{!e.allDay && e.startTime ? `, ${e.startTime}` : ''}{e.venue ? ` · ${e.venue}` : ''}</span></li>
            ))}
          </ul>
          <p className="muted">Times are in {timeZone}.</p>
        </div>
      ) : null}
    </section>
  );
}
