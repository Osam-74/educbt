/**
 * The invigilator's live board (legacy templates/portal/exams/invigilate.php,
 * board half + InvigilatorService interventions).
 *
 * Answers the four questions an invigilator actually has: who has not
 * started, who looks disconnected, who is flagged, and how long each
 * student has left. Refresh to update.
 *
 * Interventions — extra time for one student or the whole hall, and a forced
 * submission for a candidate who walked out — all require a reason, because
 * unexplained extra time is indistinguishable from favouritism.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { boardFor, grantExtension, extendPaper, forceSubmit } from '@/lib/exam/invigilate';
import { fmtDay, fmtTime } from '../../exams/labels';

export const dynamic = 'force-dynamic';

const STATE_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'Writing',
  submitted: 'Submitted',
  auto_submitted: 'Auto-submitted',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ paperId: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  const { paperId: raw } = await params;
  const query = await searchParams;
  const paperId = Number(raw);

  if (!Number.isInteger(paperId) || paperId <= 0) notFound();
  if (actor.role === 'student' || actor.role === 'parent') notFound();

  const board = await boardFor(actor, paperId);
  if (!board) notFound();

  // ── Server actions ────────────────────────────────────────────────────────
  async function extendOne(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const attemptId = Number(formData.get('attemptId'));
    const minutes = Number(formData.get('minutes') ?? 0);
    const reason = String(formData.get('reason') ?? '');
    const back = `/portal/invigilate/${paperId}`;

    const result = await grantExtension(inner, attemptId, minutes, reason);
    const messages: Record<string, string> = {
      implausible_extension: 'Extra time must be between 1 and 120 minutes.',
      reason_required: 'A reason is required — unexplained extra time is indistinguishable from favouritism.',
      attempt_closed: 'That attempt has already closed.',
      attempt_not_found: 'That attempt no longer exists.',
    };
    redirect(result.ok
      ? `${back}?ok=${encodeURIComponent(`Added ${minutes} minute(s). The clock has moved.`)}`
      : `${back}?error=${encodeURIComponent(messages[result.error] ?? 'Could not grant extra time.')}`);
  }

  async function extendAll(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const minutes = Number(formData.get('minutes') ?? 0);
    const reason = String(formData.get('reason') ?? '');
    const back = `/portal/invigilate/${paperId}`;

    const result = await extendPaper(inner, paperId, minutes, reason);
    const messages: Record<string, string> = {
      implausible_extension: 'Extra time must be between 1 and 120 minutes.',
      reason_required: 'A reason is required — unexplained extra time is indistinguishable from favouritism.',
    };
    redirect(result.ok
      ? `${back}?ok=${encodeURIComponent(`Added ${minutes} minute(s) to ${result.attemptsExtended} writing candidate(s).`)}`
      : `${back}?error=${encodeURIComponent(messages[result.error] ?? 'Could not grant extra time.')}`);
  }

  async function force(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const attemptId = Number(formData.get('attemptId'));
    const reason = String(formData.get('reason') ?? '');
    const back = `/portal/invigilate/${paperId}`;

    const result = await forceSubmit(inner, attemptId, reason);
    const messages: Record<string, string> = {
      reason_required: 'A reason is required.',
      attempt_not_found: 'That attempt no longer exists.',
    };
    redirect(result.ok
      ? `${back}?ok=${encodeURIComponent('Submitted. Their saved answers are marked as they stand.')}`
      : `${back}?error=${encodeURIComponent(messages[result.error ?? ''] ?? 'Could not submit that attempt.')}`);
  }

  const { paper, summary, students, canIntervene } = board;

  return (
    <>
      <h1 className="page-title">Live exam sessions</h1>
      <p>
        <Link href="/portal/invigilate" className="btn-small">← All live sessions</Link>
      </p>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">{query.ok}</p> : null}

      <section style={{ marginTop: 18 }}>
        <h2 className="sub-head">
          {paper.subjectName} — {paper.className ?? paper.levelName ?? 'school'}
        </h2>
        <p className="muted" style={{ marginTop: -4 }}>
          {fmtDay(paper.scheduledAt)}, {fmtTime(paper.scheduledAt)} → {fmtTime(paper.closesAt)}
        </p>
      </section>

      {paper.requiresAccessCode && paper.accessCode ? (
        <section style={{ marginTop: 12 }}>
          <h2 className="sub-head">Access code</h2>
          <p style={{ fontSize: 26, fontWeight: 700, letterSpacing: 6, margin: '6px 0' }}>{paper.accessCode}</p>
          <p className="muted" style={{ marginTop: -6 }}>
            Read this out when the paper starts. Candidates cannot open it without the code.
            {board.released ? ' Released.' : ' Not yet marked as released.'}
          </p>
        </section>
      ) : null}

      <div className="filters" style={{ marginTop: 18, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 14 }}>
        <span><strong>{summary.notStarted}</strong> not started</span>
        <span><strong>{summary.inProgress}</strong> writing</span>
        <span><strong>{summary.submitted}</strong> submitted</span>
        <span><strong>{summary.quiet}</strong> quiet</span>
        <span><strong>{summary.flagged}</strong> flagged</span>
      </div>

      {canIntervene ? (
        <section style={{ marginTop: 22, borderLeft: '4px solid var(--forest)', paddingLeft: 16 }}>
          <h2 className="sub-head">Give the whole hall extra time</h2>
          <p className="muted" style={{ marginTop: -4 }}>
            The power went out for six minutes and the whole hall needs those six minutes back —
            doing this per student, under pressure, is not workable. Applies to every candidate
            still writing.
          </p>
          <form action={extendAll} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div>
              <label htmlFor="hall-minutes">Minutes</label>
              <input id="hall-minutes" name="minutes" type="number" min="1" max="120" required style={{ width: 100 }} />
            </div>
            <div style={{ flex: '1 1 260px' }}>
              <label htmlFor="hall-reason">Reason</label>
              <input id="hall-reason" name="reason" type="text" required placeholder="Power outage in the hall…" />
            </div>
            <button type="submit">Add to every writing candidate</button>
          </form>
        </section>
      ) : null}

      <section style={{ marginTop: 22 }}>
        <h2 className="sub-head">Candidates <span className="muted">(refresh to update)</span></h2>
        {students.length === 0 ? (
          <p className="muted">No candidate is registered for this subject.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Student</th><th>State</th><th>Answered</th><th>Time left</th>
                {canIntervene ? <th>Interventions</th> : <th>Flags</th>}
              </tr>
            </thead>
            <tbody>
              {students.map((s) => (
                <tr key={s.studentId}>
                  <td>{s.name}<br />
                    <span className="muted" style={{ fontSize: 12 }}>{s.admissionNumber}</span></td>
                  <td>
                    <span className="pill pill--published">{STATE_LABEL[s.state] ?? s.state}</span>
                    {s.quiet ? <div className="muted" style={{ fontSize: 12 }}>no activity for 2 min</div> : null}
                    {s.submitReason ? <div className="muted" style={{ fontSize: 12 }}>{s.submitReason}</div> : null}
                  </td>
                  <td>{s.answered}/{s.total}</td>
                  <td>
                    {s.remainingSeconds === null ? '—' : `${Math.floor(s.remainingSeconds / 60)} min`}
                    {s.extensionMinutes > 0
                      ? <div className="muted" style={{ fontSize: 12 }}>+{s.extensionMinutes} granted</div>
                      : null}
                  </td>
                  {canIntervene ? (
                    <td style={{ minWidth: 280 }}>
                      {s.state === 'in_progress' ? (
                        <>
                          <form action={extendOne} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                            <input type="hidden" name="attemptId" value={s.attemptId ?? 0} />
                            <input name="minutes" type="number" min="1" max="120" required placeholder="Min" style={{ width: 64 }} />
                            <input name="reason" type="text" required placeholder="Reason" style={{ flex: '1 1 130px' }} />
                            <button type="submit" className="btn-small">Extend</button>
                          </form>
                          <form action={force} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            <input type="hidden" name="attemptId" value={s.attemptId ?? 0} />
                            <input name="reason" type="text" required placeholder="Reason — walked out…" style={{ flex: '1 1 130px' }} />
                            <button type="submit" className="btn-small danger">Force submit</button>
                          </form>
                        </>
                      ) : s.flags > 0 ? (
                        <span className="pill pill--returned">{s.flags} flag(s)</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  ) : (
                    <td>{s.flags > 0 ? s.flags : <span className="muted">—</span>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
