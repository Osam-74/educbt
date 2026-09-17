/**
 * Test/Exam Sessions (legacy templates/portal/exams/sessions.php).
 *
 * A principal or exam officer watches the whole school; a subject teacher
 * sees only their own subjects. Search a student's sitting history across
 * every paper, then grant a reattempt if a sitting ended unfairly. Visual
 * parity with the plugin-parity language used across the Examinations
 * area: sd-heading, sd-panel, eo-filters, eo-mini-form, tbl.
 *
 * The live "who is writing right now" board moved into this same search: a
 * student's in-progress sitting turns up here with a Watch link straight to
 * /invigilate/[paperId], exactly like the plugin folds its own live board
 * into this page.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { searchSessions, sessionFilterOptions } from '@/lib/exam/sessions';
import { isWide } from '@/lib/exam/invigilate';
import { fmtDay, fmtTime } from '../exams/labels';
import { grantReattemptAction } from './actions';

export const dynamic = 'force-dynamic';

const STATUS_OPTIONS = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'auto_submitted', label: 'Auto-submitted' },
  { value: 'expired', label: 'Expired' },
  { value: 'cancelled', label: 'Cancelled' },
];

const TYPE_OPTIONS = [
  { value: 'examination', label: 'Examination' },
  { value: 'ca_test', label: 'CA Test' },
  { value: 'practice', label: 'Practice' },
];

const STATUS_LABEL: Record<string, string> = {
  in_progress: 'In progress', submitted: 'Submitted', auto_submitted: 'Auto-submitted',
  expired: 'Expired', cancelled: 'Cancelled',
};

export default async function TestExamSessionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string; subjectId?: string; status?: string; type?: string;
    classId?: string; sessionId?: string; termId?: string; ok?: string; error?: string;
  }>;
}) {
  const actor = await requireSchoolSession();
  if (actor.role === 'student' || actor.role === 'parent') notFound();

  const wide = isWide(actor);
  const query = await searchParams;

  const filters = {
    q: query.q,
    subjectId: query.subjectId ? Number(query.subjectId) : undefined,
    status: query.status,
    seriesType: query.type,
    classId: query.classId ? Number(query.classId) : undefined,
    sessionId: query.sessionId ? Number(query.sessionId) : undefined,
    termId: query.termId ? Number(query.termId) : undefined,
  };

  const hasFilter = Boolean(filters.q?.trim() || filters.subjectId || filters.status
    || filters.seriesType || filters.classId || filters.sessionId || filters.termId);

  const [options, rows] = await Promise.all([
    sessionFilterOptions(actor),
    searchSessions(actor, filters),
  ]);

  const backHref = `/portal/invigilate${Object.entries(query).filter(([k]) => k !== 'ok' && k !== 'error').length
    ? '?' + new URLSearchParams(Object.entries(query).filter(([k, v]) => k !== 'ok' && k !== 'error' && v) as string[][]).toString()
    : ''}`;

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Test/Exam Sessions</h1>
          <p>
            Search for a student to see their test and exam session history.
            If a session ended unfairly, you can grant a reattempt.
          </p>
        </div>
      </div>

      {query.error ? <p className="error">{decodeURIComponent(query.error)}</p> : null}
      {query.ok ? <p className="ok">Reattempt granted — the student can sit the paper again.</p> : null}

      <section className="sd-panel sd-panel--wide">
        <div style={{ padding: '20px 22px 4px' }}>
          <form method="get" className="eo-filters" style={{ margin: 0, padding: 0 }}>
            <label style={{ flex: '1 1 220px' }}>
              <span>Search student</span>
              <input type="text" name="q" defaultValue={query.q ?? ''} placeholder="Name or admission number" />
            </label>
            <label>
              <span>Subject</span>
              <select name="subjectId" defaultValue={query.subjectId ?? ''}>
                <option value="">All subjects</option>
                {options.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select name="status" defaultValue={query.status ?? ''}>
                <option value="">All</option>
                {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </label>
            <label>
              <span>Type</span>
              <select name="type" defaultValue={query.type ?? ''}>
                <option value="">All</option>
                {TYPE_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label>
              <span>Class</span>
              <select name="classId" defaultValue={query.classId ?? ''}>
                <option value="">All classes</option>
                {options.classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>
              <span>Session</span>
              <select name="sessionId" defaultValue={query.sessionId ?? ''}>
                <option value="">All sessions</option>
                {options.sessions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </label>
            <label>
              <span>Term</span>
              <select name="termId" defaultValue={query.termId ?? ''}>
                <option value="">All terms</option>
                {options.terms.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </select>
            </label>
            <button type="submit" className="sd-action">Filter</button>
          </form>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: '10px 22px 22px' }}>
            <p className="muted">
              {hasFilter
                ? 'No sessions found. Try a different name, admission number, or filter.'
                : 'Nobody is currently sitting a test or exam. Search above for a student to see their session history.'}
            </p>
          </div>
        ) : (
          <div className="sd-table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Student</th><th>Subject</th><th>Class</th><th>Series</th>
                  <th>Status</th><th>Sat</th><th>Score</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.attemptId}>
                    <td><strong>{r.studentName}</strong><br /><span className="muted mono">{r.admissionNumber}</span></td>
                    <td>{r.subjectName}</td>
                    <td>{r.className ?? '—'}</td>
                    <td>{r.seriesTitle}</td>
                    <td>
                      <span className="sd-stage">{STATUS_LABEL[r.status] ?? r.status}</span>
                      {r.integrityCount > 0 ? <><br /><span className="muted" style={{ fontSize: 11 }}>{r.integrityCount} flag{r.integrityCount === 1 ? '' : 's'}</span></> : null}
                    </td>
                    <td>{fmtDay(r.startedAt)}, {fmtTime(r.startedAt)}</td>
                    <td>{r.score !== null ? `${Number(r.score)} / ${Number(r.maxScore)}` : '—'}</td>
                    <td>
                      {r.status === 'in_progress' ? (
                        <Link href={`/portal/invigilate/${r.paperId}`} className="linkish">Watch</Link>
                      ) : r.canReattempt ? (
                        <form action={grantReattemptAction} className="eo-mini-form" style={{ justifyContent: 'flex-end' }}>
                          <input type="hidden" name="attemptId" value={r.attemptId} />
                          <input type="hidden" name="back" value={backHref} />
                          <input type="text" name="reason" required placeholder="Why? (required)" style={{ width: 150 }} />
                          <button type="submit" className="sd-action sd-action--ghost">Grant reattempt</button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
