import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { reviewSet } from '@/lib/exam/sets';
import { snapshotSet } from '@/lib/exam/vault';
import { PortalIcon } from '../../PortalShell';

export const dynamic = 'force-dynamic';

const DELIVERY_LABEL: Record<string, string> = { cbt: 'CBT', written: 'Written' };
const TYPE_LABEL: Record<string, string> = { objective: 'Objective', theory: 'Theory' };

/**
 * Approve Questions (legacy templates/portal/exams/approvals.php, 'Question
 * Approval'). The plugin's reviewer screen shows every submission against
 * its quota with Type/Delivery/Class filters, then expands one to review
 * inline. Quotas and the collection window are set from the Question Bank
 * page here (they share one settings value — see /portal/questions), so
 * this page keeps the review queue and its filters, matching the plugin's
 * own submissions table.
 */
export default async function ApproveQuestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string; subject?: string; delivery?: string; type?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();

  // Server-side. The nav link is convenience; this is what protects the route.
  requireRole(actor, SCHOOL_WIDE);

  const pending = await forSchool(actor.schoolId, async (tx) =>
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
  );

  // Filters — Subject / Delivery / Type. Same submissions query as before;
  // narrowed here rather than with the plugin's client-side script.
  const subjects = [...new Map(pending.map((s) => [s.subjectId, s.subjectName])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]));
  const subjectFilter = query.subject ? Number(query.subject) : 0;
  const deliveryFilter = query.delivery ?? '';
  const typeFilter = query.type ?? '';

  const visible = pending.filter((s) =>
    (!subjectFilter || s.subjectId === subjectFilter)
    && (!deliveryFilter || s.deliveryMode === deliveryFilter)
    && (!typeFilter || s.examType === typeFilter));

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

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="approvals" />Submissions</h2></header>
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

      <p className="muted">
        Sending a set back requires a reason. A rejection without one is one the
        teacher cannot act on. Minimum question counts and the open collection
        window are set from <Link href="/portal/questions">Question Bank</Link>.
      </p>
    </div>
  );
}
