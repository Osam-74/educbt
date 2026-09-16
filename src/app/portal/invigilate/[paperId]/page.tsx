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
 *
 * Visual parity: sd-heading with a back link, the eo-status-bar strip used
 * for "N of M" summaries elsewhere in this area, an accent callout for the
 * hall-wide extension (matching the plugin's border-left notice), and the
 * shared tbl for candidates.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { boardFor, grantExtension, extendPaper, forceSubmit } from '@/lib/exam/invigilate';
import { fmtDay, fmtTime } from '../../exams/labels';
import { PortalIcon } from '../../PortalShell';

export const dynamic = 'force-dynamic';

const STATE_LABEL: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'Writing',
  submitted: 'Submitted',
  auto_submitted: 'Auto-submitted',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const STATE_PILL: Record<string, string> = {
  not_started: 'pill--draft',
  in_progress: 'pill--submitted',
  submitted: 'pill--published',
  auto_submitted: 'pill--published',
  expired: 'pill--closed',
  cancelled: 'pill--closed',
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
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>{paper.subjectName} — {paper.className ?? paper.levelName ?? 'school'}</h1>
          <p>{fmtDay(paper.scheduledAt)}, {fmtTime(paper.scheduledAt)} → {fmtTime(paper.closesAt)}</p>
        </div>
        <Link href="/portal/invigilate" className="eo-link">← All live sessions</Link>
      </div>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok ? <p className="ok">{query.ok}</p> : null}

      {paper.requiresAccessCode && paper.accessCode ? (
        <section className="sd-panel sd-panel--wide sd-panel--accent" style={{ marginBottom: 22 }}>
          <div>
            <h2>Access code</h2>
            <p style={{ fontSize: 28, fontWeight: 700, letterSpacing: 6, margin: '10px 0 6px', color: '#173c26' }}>
              {paper.accessCode}
            </p>
            <p className="muted" style={{ margin: 0 }}>
              Read this out when the paper starts. Candidates cannot open it without the code.
              {board.released ? ' Released.' : ' Not yet marked as released.'}
            </p>
          </div>
        </section>
      ) : null}

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <div className="eo-status-bar">
          <span><strong>{summary.notStarted}</strong> not started</span>
          <span><strong>{summary.inProgress}</strong> writing</span>
          <span><strong>{summary.submitted}</strong> submitted</span>
          <span><strong>{summary.quiet}</strong> quiet</span>
          <span><strong>{summary.flagged}</strong> flagged</span>
        </div>
      </section>

      {canIntervene ? (
        <section className="sd-panel sd-panel--wide sd-panel--accent" style={{ marginBottom: 22 }}>
          <div>
            <h2>Give the whole hall extra time</h2>
            <p className="muted" style={{ margin: '0 0 14px' }}>
              The power went out for six minutes and the whole hall needs those six minutes back —
              doing this per student, under pressure, is not workable. Applies to every candidate
              still writing.
            </p>
            <form action={extendAll} className="eo-mini-form">
              <label>Minutes
                <input name="minutes" type="number" min="1" max="120" required style={{ width: 90 }} />
              </label>
              <label style={{ flex: '1 1 260px' }}>Reason
                <input name="reason" type="text" required placeholder="Power outage in the hall…" />
              </label>
              <button type="submit" className="sd-action">Add to every writing candidate</button>
            </form>
          </div>
        </section>
      ) : null}

      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="sessions" />Candidates <span className="sd-panel-note">(refresh to update)</span></h2></header>
        {students.length === 0 ? (
          <div style={{ padding: 20 }}>
            <p className="muted">No candidate is registered for this subject.</p>
          </div>
        ) : (
          <div className="sd-table-wrap">
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
                      <span className={`pill ${STATE_PILL[s.state] ?? ''}`}>{STATE_LABEL[s.state] ?? s.state}</span>
                      {s.quiet ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>no activity for 2 min</div> : null}
                      {s.submitReason ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{s.submitReason}</div> : null}
                    </td>
                    <td>{s.answered}/{s.total}</td>
                    <td>
                      {s.remainingSeconds === null ? '—' : `${Math.floor(s.remainingSeconds / 60)} min`}
                      {s.extensionMinutes > 0
                        ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>+{s.extensionMinutes} granted</div>
                        : null}
                    </td>
                    {canIntervene ? (
                      <td style={{ minWidth: 300 }}>
                        {s.state === 'in_progress' ? (
                          <>
                            <form action={extendOne} className="eo-mini-form" style={{ marginBottom: 8 }}>
                              <input type="hidden" name="attemptId" value={s.attemptId ?? 0} />
                              <input name="minutes" type="number" min="1" max="120" required placeholder="Min" style={{ width: 60 }} />
                              <input name="reason" type="text" required placeholder="Reason" style={{ flex: '1 1 120px' }} />
                              <button type="submit" className="btn-small">Extend</button>
                            </form>
                            <form action={force} className="eo-mini-form">
                              <input type="hidden" name="attemptId" value={s.attemptId ?? 0} />
                              <input name="reason" type="text" required placeholder="Reason — walked out…" style={{ flex: '1 1 120px' }} />
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
          </div>
        )}
      </section>
    </div>
  );
}
