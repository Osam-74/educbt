import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { reviewSet, listAllSubmissions } from '@/lib/exam/sets';
import { snapshotSet } from '@/lib/exam/vault';
import { collectionView } from '@/lib/exam/collection';
import { PortalIcon } from '../../PortalShell';
import { saveRequirement, backupNow, restoreNow, deleteSubmission } from './actions';

export const dynamic = 'force-dynamic';

const DELIVERY_LABEL: Record<string, string> = { cbt: 'CBT', written: 'Written' };
const TYPE_LABEL: Record<string, string> = { objective: 'Objective', theory: 'Theory' };
const SERIES_LABEL: Record<string, string> = { examination: 'Examination', ca_test: 'CA Test', practice: 'Practice' };
const STATUS_LABEL: Record<string, string> = {
  draft: 'In progress', submitted: 'Submitted', under_review: 'Under review',
  returned: 'Sent back', approved: 'Approved', published: 'Published',
};
const STATUS_PILL: Record<string, string> = {
  draft: 'pill--draft', submitted: 'pill--submitted', under_review: 'pill--under_review',
  returned: 'pill--returned', approved: 'pill--approved', published: 'pill--published',
};

/**
 * Approve Questions (legacy templates/portal/exams/approvals.php, 'Question
 * Approval'). Three regions, matching the plugin: the minimum-per-subject
 * requirement, safekeeping (backup/restore of the whole bank), and the full
 * submissions ledger with Type/Delivery/Class filters and a delete action —
 * with the pending review queue (approve/send back) kept above it, since
 * that is where a reviewer actually acts on a set.
 */
export default async function ApproveQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; subject?: string; delivery?: string; type?: string; cls?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();

  // Server-side. The nav link is convenience; this is what protects the route.
  requireRole(actor, SCHOOL_WIDE);

  const [pending, ledger, bank] = await Promise.all([
    forSchool(actor.schoolId, async (tx) =>
      tx
        .select({
          id: schema.questionSets.id,
          examType: schema.questionSets.examType,
          deliveryMode: schema.questionSets.deliveryMode,
          status: schema.questionSets.status,
          submittedAt: schema.questionSets.submittedAt,
          subjectId: schema.questionSets.subjectId,
          subjectName: schema.subjects.name,
          levelName: schema.classLevels.name,
          teacherFirst: schema.staff.firstName,
          teacherLast: schema.staff.lastName,
          questionCount: sql<number>`(
            SELECT count(*) FROM ${schema.questions} q
            WHERE q.question_set_id = ${schema.questionSets.id} AND q.status = 'active'
          )`.mapWith(Number),
        })
        .from(schema.questionSets)
        .innerJoin(schema.subjects, eq(schema.subjects.id, schema.questionSets.subjectId))
        .innerJoin(schema.classLevels, eq(schema.classLevels.id, schema.questionSets.levelId))
        .leftJoin(schema.staff, eq(schema.staff.id, schema.questionSets.teacherId))
        .where(and(
          eq(schema.questionSets.schoolId, actor.schoolId),
          inArray(schema.questionSets.status, ['submitted', 'under_review']),
        )),
    ),
    listAllSubmissions(actor),
    collectionView(actor),
  ]);

  // Filters — Subject / Delivery / Type / Class. Same submissions query as
  // before for the pending queue; the ledger below carries its own set.
  const subjects = [...new Map(pending.map((s) => [s.subjectId, s.subjectName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const subjectFilter = query.subject ? Number(query.subject) : 0;
  const deliveryFilter = query.delivery ?? '';
  const typeFilter = query.type ?? '';
  const classFilter = query.cls ?? '';

  const visible = pending.filter((s) =>
    (!subjectFilter || s.subjectId === subjectFilter)
    && (!deliveryFilter || s.deliveryMode === deliveryFilter)
    && (!typeFilter || s.examType === typeFilter));

  const classOptions = [...new Set(ledger.map((r) => r.levelName))].sort();
  const visibleLedger = ledger.filter((r) =>
    (!deliveryFilter || r.deliveryMode === deliveryFilter)
    && (!typeFilter || (typeFilter === 'objective' ? r.objective : r.theory))
    && (!classFilter || r.levelName === classFilter));

  const returnQuery = new URLSearchParams({ subject: query.subject ?? '', delivery: query.delivery ?? '', type: query.type ?? '', cls: query.cls ?? '' }).toString();

  async function decide(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    const setId = Number(formData.get('setId'));
    const decision = String(formData.get('decision')) as 'approve' | 'return';
    const comment = String(formData.get('comment') ?? '').trim();

    try {
      await reviewSet(inner, setId, decision, comment);
    } catch (e) {
      redirect(`/portal/exams/approvals?error=${encodeURIComponent(e instanceof Error ? e.message : 'Failed.')}`);
    }

    // Snapshot on approval: this is the version that will actually be sat.
    if (decision === 'approve') await snapshotSet(inner.schoolId, setId, 'approved');

    redirect(`/portal/exams/approvals?ok=${decision}`);
  }

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Approve Questions</h1>
          <p>
            Every teacher&rsquo;s submission, so you can see at a glance who is short and
            who is waiting, then review the questions and approve or send a set back.
          </p>
        </div>
      </div>

      {query.error ? <p className="error">{query.error}</p> : null}
      {query.ok === 'approve' ? <p className="ok">Set approved.</p> : null}
      {query.ok === 'return' ? <p className="ok">Sent back to the teacher.</p> : null}
      {query.ok && !['approve', 'return'].includes(query.ok) ? <p className="ok">{query.ok}</p> : null}

      <div className="sd-panels" style={{ marginBottom: 22 }}>
        <section className="sd-panel">
          <header><h2><PortalIcon name="approvals" />Minimum required per subject</h2></header>
          <div style={{ padding: '18px 22px' }}>
            <p className="muted" style={{ marginTop: 0 }}>
              How many questions a teacher must write before a set can be submitted. Applies
              to new sets; a set already in progress keeps the requirement it was started
              under.
            </p>
            <form action={saveRequirement} className="eo-mini-form">
              <input type="hidden" name="returnQuery" value={returnQuery} />
              <label style={{ minWidth: 140 }}>
                Objective target
                <input name="objective" type="number" min="1" max="500" required defaultValue={bank.config.objective} />
              </label>
              <label style={{ minWidth: 140 }}>
                Theory target
                <input name="theory" type="number" min="1" max="100" required defaultValue={bank.config.theory} />
              </label>
              <button type="submit" className="sd-action">Save requirement</button>
            </form>
          </div>
        </section>

        <section className="sd-panel">
          <header><h2><PortalIcon name="transcripts" />Safekeeping</h2></header>
          <div style={{ padding: '18px 22px' }}>
            <p className="muted" style={{ marginTop: 0 }}>
              A snapshot of every submitted or approved set survives even if its questions are
              ever wiped. Back up on demand, or bring missing questions straight back.
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <form action={backupNow}><input type="hidden" name="returnQuery" value={returnQuery} />
                <button type="submit" className="sd-action sd-action--ghost">Back up question bank now</button>
              </form>
              <form action={restoreNow}><input type="hidden" name="returnQuery" value={returnQuery} />
                <button type="submit" className="sd-action sd-action--ghost">Restore missing questions</button>
              </form>
            </div>
          </div>
        </section>
      </div>

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="approvals" />Submissions awaiting review</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {pending.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>No questions have been submitted yet.</p>
          ) : (
            <>
              <form method="get" className="eo-filters" style={{ margin: '14px 0 4px' }}>
                <label>
                  <span>Subject</span>
                  <select name="subject" defaultValue={subjectFilter || ''}>
                    <option value="">All subjects</option>
                    {subjects.map(([id, name]) => (
                      <option key={id} value={id}>{name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Delivery</span>
                  <select name="delivery" defaultValue={deliveryFilter}>
                    <option value="">All modes</option>
                    <option value="cbt">CBT</option>
                    <option value="written">Written</option>
                  </select>
                </label>
                <label>
                  <span>Type</span>
                  <select name="type" defaultValue={typeFilter}>
                    <option value="">All types</option>
                    <option value="objective">Objective</option>
                    <option value="theory">Theory</option>
                  </select>
                </label>
                <button type="submit" className="sd-action sd-action--ghost">Apply</button>
                {(subjectFilter || deliveryFilter || typeFilter) ? (
                  <Link href="/portal/exams/approvals" className="eo-filters__reset">Clear</Link>
                ) : null}
              </form>

              {visible.length === 0 ? (
                <p className="muted" style={{ margin: '18px 0' }}>No submissions match this filter.</p>
              ) : (
                visible.map((s) => (
                  <section className="eo-review-card" key={s.id}>
                    <h3>
                      {s.subjectName} — {s.levelName}
                      <span className="muted" style={{ fontWeight: 400, fontSize: 14 }}>
                        {' '}({TYPE_LABEL[s.examType] ?? s.examType}, {DELIVERY_LABEL[s.deliveryMode] ?? s.deliveryMode}, {s.questionCount} questions)
                      </span>
                    </h3>
                    <p className="muted">
                      Submitted by {s.teacherFirst ?? '—'} {s.teacherLast ?? ''}
                      {s.submittedAt ? ` on ${s.submittedAt.toISOString().slice(0, 10)}` : ''}
                      {' · '}
                      <Link href={`/portal/questions/${s.id}`}>Read the questions</Link>
                    </p>

                    <form action={decide} className="eo-review-card__form">
                      <input type="hidden" name="setId" value={s.id} />
                      <label htmlFor={`c_${s.id}`}>Comment</label>
                      <input id={`c_${s.id}`} name="comment" type="text"
                             placeholder="Required when sending back — at least 10 characters" />
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button type="submit" name="decision" value="approve" className="sd-action">
                          <PortalIcon name="check" />Approve
                        </button>
                        <button type="submit" name="decision" value="return" className="sd-action sd-action--danger">
                          Send back
                        </button>
                      </div>
                    </form>
                  </section>
                ))
              )}
            </>
          )}
        </div>
      </section>

      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="approvals" />Every submission</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          <p className="muted" style={{ margin: '10px 0 18px' }}>
            The safekeeping ledger — every paper the school has ever received, approved or not.
          </p>
          <form method="get" className="eo-filters" style={{ margin: '0 0 4px' }}>
            <label>
              <span>Filter by Type</span>
              <select name="type" defaultValue={typeFilter}>
                <option value="">All types</option>
                <option value="objective">Objective</option>
                <option value="theory">Theory</option>
              </select>
            </label>
            <label>
              <span>Filter by Delivery</span>
              <select name="delivery" defaultValue={deliveryFilter}>
                <option value="">All modes</option>
                <option value="cbt">CBT</option>
                <option value="written">Written</option>
              </select>
            </label>
            <label>
              <span>Filter by Class</span>
              <select name="cls" defaultValue={classFilter}>
                <option value="">All classes</option>
                {classOptions.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <button type="submit" className="sd-action sd-action--ghost">Apply</button>
            {(deliveryFilter || typeFilter || classFilter) ? (
              <Link href="/portal/exams/approvals" className="eo-filters__reset">Clear</Link>
            ) : null}
          </form>

          {visibleLedger.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>Nothing matches this filter.</p>
          ) : (
            <div className="qs-ledger-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Teacher</th><th>Subject</th><th>Class</th><th>Type</th><th>Delivery</th>
                    <th>Objective</th><th>Theory</th><th>Status</th><th>Submitted</th><th />
                  </tr>
                </thead>
                <tbody>
                  {visibleLedger.map((r) => (
                    <tr key={r.key}>
                      <td>{r.teacherFirst ?? '—'} {r.teacherLast ?? ''}</td>
                      <td>{r.subjectName}</td>
                      <td>{r.levelName}</td>
                      <td><span className={`tag ${r.seriesType === 'examination' ? 'tag--exam' : 'tag--ca'}`}>{SERIES_LABEL[r.seriesType] ?? r.seriesType}</span>{r.waecMode ? <span className="tag">WAEC</span> : null}</td>
                      <td>{DELIVERY_LABEL[r.deliveryMode] ?? r.deliveryMode}</td>
                      <td>
                        {r.objective ? (
                          <>{r.objective.count}{r.objective.count < r.objective.min ? <span className="pill pill--returned" style={{ marginLeft: 6 }}>{r.objective.min - r.objective.count} below minimum</span> : null}</>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>
                        {r.theory ? (
                          <>{r.theory.count}{r.theory.count < r.theory.min ? <span className="pill pill--returned" style={{ marginLeft: 6 }}>{r.theory.min - r.theory.count} below minimum</span> : null}</>
                        ) : <span className="muted">—</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span className={`pill ${STATUS_PILL[r.objective?.status ?? ''] ?? 'pill--draft'}`}>Objective: {r.objective ? (STATUS_LABEL[r.objective.status] ?? r.objective.status) : 'Not started'}</span>
                          <span className={`pill ${STATUS_PILL[r.theory?.status ?? ''] ?? 'pill--draft'}`}>Theory: {r.theory ? (STATUS_LABEL[r.theory.status] ?? r.theory.status) : 'Not started'}</span>
                        </div>
                      </td>
                      <td>{r.submittedAt ? new Date(r.submittedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          {r.objective ? <Link href={`/portal/questions/${r.objective.setId}`} className="eo-link">Review Obj.</Link> : null}
                          {r.theory ? <Link href={`/portal/questions/${r.theory.setId}`} className="eo-link">Review Th.</Link> : null}
                          {r.objective ? (
                            <form action={deleteSubmission}><input type="hidden" name="returnQuery" value={returnQuery} /><input type="hidden" name="setId" value={r.objective.setId} />
                              <button type="submit" className="sd-action sd-action--danger sd-action--small">Delete Obj.</button>
                            </form>
                          ) : null}
                          {r.theory ? (
                            <form action={deleteSubmission}><input type="hidden" name="returnQuery" value={returnQuery} /><input type="hidden" name="setId" value={r.theory.setId} />
                              <button type="submit" className="sd-action sd-action--danger sd-action--small">Delete Th.</button>
                            </form>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <p className="muted" style={{ marginTop: 18 }}>
        Sending a set back requires a reason. A rejection without one is one the
        teacher cannot act on. The open collection window is set from{' '}
        <Link href="/portal/exams/papers">Exam Papers</Link>.
      </p>
    </div>
  );
}
