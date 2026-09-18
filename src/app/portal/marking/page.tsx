/**
 * Marking (legacy templates/portal/exams/marking.php).
 *
 * Two different jobs behind one name:
 *  - A teacher sees their own theory scripts waiting to be marked — the
 *    queue below, unchanged since it was built.
 *  - A school-wide role (principal, VP, exam officer) sees the oversight
 *    version instead: who across the school is sitting on scripts, which
 *    teachers have recorded their CA components, and how much theory
 *    marking is left on exams that have already been sat. Visual parity
 *    with the plugin-parity language used across the Examinations area:
 *    sd-heading, sd-panel, eo-filters, eo-progress, sd-stage.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireSchoolSession, SCHOOL_WIDE } from '@/lib/session';
import { markingQueue, awardMarks } from '@/lib/exam/results';
import { schoolMarkingStatus, caProgressByTeacher, completedExamsMarkingStatus } from '@/lib/exam/marking-overview';
import { PortalIcon } from '../PortalShell';

export const dynamic = 'force-dynamic';

export default async function MarkingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; teacherId?: string; subjectId?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();
  const wide = SCHOOL_WIDE.includes(actor.role as (typeof SCHOOL_WIDE)[number]);

  async function award(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    const answerId = Number(formData.get('answerId'));
    const marks = Number(formData.get('marks'));

    const result = await awardMarks(inner, answerId, marks);

    redirect(result.ok
      ? '/portal/marking?ok=1'
      : `/portal/marking?error=${encodeURIComponent(result.reason ?? 'Failed.')}`);
  }

  if (!wide) {
    const queue = await markingQueue(actor);

    return (
      <div className="school-dashboard">
        <div className="sd-heading">
          <div>
            <p className="sd-eyebrow">Examination office</p>
            <h1>Marking</h1>
            <p>Written answers waiting on you, for the subjects you teach.</p>
          </div>
        </div>

        {query.error ? <p className="error">{query.error}</p> : null}
        {query.ok ? <p className="ok">Marked.</p> : null}

        {queue.length === 0 ? (
          <section className="sd-panel sd-panel--wide">
            <div style={{ padding: 20 }}>
              <p className="muted">
                Nothing to mark. Written answers appear here once a paper has been sat, for the subjects you teach.
              </p>
            </div>
          </section>
        ) : (
          <>
            <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
              <div className="eo-status-bar">
                <span><strong>{queue.length}</strong> answer{queue.length === 1 ? '' : 's'} waiting.</span>
              </div>
            </section>

            {queue.map((a) => (
              <section className="eo-review-card" key={a.answerId}>
                <p className="muted" style={{ margin: '0 0 8px' }}>
                  {a.subjectName} · {a.studentName}
                  <span className="mono"> ({a.admissionNumber})</span>
                </p>
                <h3>{a.questionText}</h3>

                {a.markingGuide ? (
                  <p className="note" style={{ marginTop: 10 }}>
                    <strong>Guide:</strong> {a.markingGuide}
                  </p>
                ) : null}

                <div className="answer-box" style={{ marginTop: 10 }}>
                  {a.textAnswer || <em className="muted">No answer given.</em>}
                </div>

                <form action={award} className="eo-review-card__form">
                  <input type="hidden" name="answerId" value={a.answerId} />
                  <label htmlFor={`m_${a.answerId}`}>Marks (max {Number(a.maxMarks)})</label>
                  <input id={`m_${a.answerId}`} name="marks" type="number"
                         min="0" max={Number(a.maxMarks)} step="0.5"
                         required style={{ maxWidth: 110 }} />
                  <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Award</button>
                </form>
              </section>
            ))}
          </>
        )}
      </div>
    );
  }

  // ── School-wide overview ────────────────────────────────────────────────
  const teacherId = query.teacherId ? Number(query.teacherId) : undefined;
  const subjectId = query.subjectId ? Number(query.subjectId) : undefined;

  const [status, progress, completed] = await Promise.all([
    schoolMarkingStatus(actor),
    caProgressByTeacher(actor, { teacherId, subjectId }),
    completedExamsMarkingStatus(actor),
  ]);

  const STATUS_LABEL: Record<string, string> = { not_started: 'Not Started', in_progress: 'In Progress', all_recorded: 'All Recorded' };
  const STATUS_CLASS: Record<string, string> = { not_started: 'sd-stage-draft', in_progress: 'sd-stage-in-progress', all_recorded: 'sd-stage-published' };

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Marking Status</h1>
        </div>
      </div>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">Marked.</p> : null}

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="marking" />Marking status by teacher</h2></header>
        <div style={{ padding: status.rows.length ? 0 : '0 22px 20px' }}>
          {status.rows.length === 0 ? (
            <p className="muted">No written answers are waiting to be marked.</p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead><tr><th>Teacher</th><th>Subject</th><th>Waiting</th></tr></thead>
                <tbody>
                  {status.rows.map((r) => (
                    <tr key={`${r.teacherId}-${r.subjectName}`}>
                      <td>{r.teacherName}</td>
                      <td>{r.subjectName}</td>
                      <td>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="marking" />CA assessment progress by teacher</h2></header>
        <div style={{ padding: '0 22px 18px' }}>
          <p className="muted" style={{ margin: '0 0 14px' }}>
            How many assessment components each teacher has recorded for the current term.
            {progress.components.length
              ? ` Components: ${progress.components.map((c) => c.label).join(', ')}.`
              : ' Set up assessment components in School Settings first.'}
          </p>

          <form method="get" className="eo-filters" style={{ margin: '0 0 4px' }}>
            <label>
              <span>Teacher</span>
              <select name="teacherId" defaultValue={teacherId ?? ''}>
                <option value="">All teachers…</option>
                {progress.teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label>
              <span>Subject</span>
              <select name="subjectId" defaultValue={subjectId ?? ''}>
                <option value="">All subjects…</option>
                {progress.subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <button type="submit" className="sd-action sd-action--ghost">Apply</button>
            {(teacherId || subjectId) ? <Link href="/portal/marking" className="eo-filters__reset">Clear</Link> : null}
          </form>
        </div>

        {progress.rows.length === 0 ? (
          <div style={{ padding: '0 22px 20px' }}>
            <p className="muted">
              {progress.teachers.length === 0
                ? 'No subject-teacher assignments yet.'
                : 'No assignments match this filter.'}
            </p>
          </div>
        ) : (
          <div className="sd-table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Teacher</th><th>Subject</th><th>Class</th><th>Components recorded</th>
                  <th>Progress</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {progress.rows.map((r) => {
                  const pct = r.totalCount ? Math.round((r.doneCount / r.totalCount) * 100) : 0;
                  return (
                    <tr key={`${r.teacherId}-${r.subjectId}-${r.classId}`}>
                      <td><strong>{r.teacherName}</strong></td>
                      <td>{r.subjectName}</td>
                      <td>{r.className}</td>
                      <td>
                        {r.doneCount} / {r.totalCount} (
                        {r.recorded.map((c, i) => (
                          <span key={c.key}>{i > 0 ? ' · ' : ''}{c.done ? '✓' : '✗'} {c.label}</span>
                        ))}
                        )
                      </td>
                      <td>
                        <span className="eo-progress">
                          <span className="eo-progress__bar"><span className="eo-progress__fill" style={{ width: `${pct}%` }} /></span>
                          <span className="eo-progress__text">{pct}%</span>
                        </span>
                      </td>
                      <td><span className={`sd-stage ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="marking" />Completed exams — marking status</h2></header>
        <div style={{ padding: completed.length ? 0 : '0 22px 20px' }}>
          {completed.length === 0 ? (
            <p className="muted">No exams have been sat yet.</p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead><tr><th>Subject</th><th>Class</th><th>Theory marked</th></tr></thead>
                <tbody>
                  {completed.map((c) => (
                    <tr key={c.paperId}>
                      <td>{c.subjectName}</td>
                      <td>{c.className ?? '—'}</td>
                      <td>{c.markedTheory} / {c.totalTheory}</td>
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
