import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import {
  canRunPromotion, canCommitPromotion, defaultRules, promotionRulesSchema,
  proposePromotion, promotionBatches, promotionReview,
  overridePromotion, bulkOverridePromotion, commitPromotion, reversePromotion,
} from '@/lib/promotion/promotion';

export const dynamic = 'force-dynamic';

const OUTCOMES = [
  ['promote', 'Promote'],
  ['trial', 'Promote on trial'],
  ['repeat', 'Repeat the class'],
  ['graduate', 'Graduate'],
] as const;

/**
 * Promotion office (legacy EduCBT Pro parity: templates/portal/promotion.php).
 *
 * Rule-driven batch with human review: the exam office proposes, the principal
 * reviews counts and exceptions on ONE screen, overrides individuals with a
 * written reason, and only the principal commits. The proposal is stored, not
 * applied — nothing moves until a human says so.
 */
export default async function PromotionPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  if (!canRunPromotion(actor)) redirect('/portal');
  const query = await searchParams;
  const canCommit = canCommitPromotion(actor);

  const batchId = Number(query.batch) || 0;
  const review = batchId ? await promotionReview(actor, batchId).catch(() => null) : null;
  const batches = await promotionBatches(actor);

  const options = review ? null : await forSchool(actor.schoolId, async (tx) => ({
    sessions: await tx.select({ id: schema.academicSessions.id, title: schema.academicSessions.title })
      .from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, actor.schoolId))
      .orderBy(asc(schema.academicSessions.title)),
    levels: await tx.select({ id: schema.classLevels.id, name: schema.classLevels.name })
      .from(schema.classLevels).where(eq(schema.classLevels.schoolId, actor.schoolId))
      .orderBy(asc(schema.classLevels.levelOrder)),
  }));

  const defaults = defaultRules();

  async function propose(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const rules = promotionRulesSchema.safeParse({
      passMark: Number(formData.get('passMark')),
      promoteAverage: Number(formData.get('promoteAverage')),
      trialAverage: Number(formData.get('trialAverage')),
      minSubjectsPassed: Number(formData.get('minSubjectsPassed')),
      requireCore: formData.get('requireCore') === '1',
    });
    if (!rules.success) redirect('/portal/promotion?error=' + encodeURIComponent('Enter valid promotion rules.'));
    let destination: string;
    try {
      const result = await proposePromotion(inner, {
        fromSessionId: Number(formData.get('fromSessionId')),
        toSessionId: Number(formData.get('toSessionId')),
        levelId: Number(formData.get('levelId')),
        rules: rules.data,
      });
      destination = `/portal/promotion?batch=${result.batchId}&ok=${encodeURIComponent(
        `Proposal created: ${result.summary.promoted} promoted, ${result.summary.trial} on trial, ${result.summary.repeated} repeating, ${result.summary.graduated} graduating, ${result.summary.unresolved} unresolved.`)}`;
    } catch (error) {
      destination = `/portal/promotion?error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not create the proposal.')}`;
    }
    redirect(destination);
  }

  async function override(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const ids = formData.getAll('studentIds').map(Number).filter(n => Number.isInteger(n) && n > 0);
    const outcome = String(formData.get('outcome') ?? '');
    const reason = String(formData.get('reason') ?? '');
    const back = `/portal/promotion?batch=${batchId}`;
    let destination = `${back}&error=${encodeURIComponent('Select at least one student.')}`;
    try {
      if (ids.length > 1) await bulkOverridePromotion(inner, batchId, ids, outcome, reason);
      else if (ids.length === 1) await overridePromotion(inner, batchId, ids[0]!, outcome, reason);
      destination = `${back}&ok=${encodeURIComponent(`Decision recorded for ${ids.length} student(s).`)}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not record that decision.')}`;
    }
    redirect(destination);
  }

  async function commit(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/promotion?batch=${batchId}`;
    let destination: string;
    try {
      const result = await commitPromotion(inner, batchId);
      destination = `${back}&ok=${encodeURIComponent(
        `Promotion committed: ${result.enrolled} student(s) enrolled in the new session, ${result.graduated} graduated.`)}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not commit the promotion.')}`;
    }
    redirect(destination);
  }

  async function reverse(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/promotion?batch=${batchId}`;
    let destination: string;
    try {
      const result = await reversePromotion(inner, batchId, String(formData.get('reason') ?? ''));
      destination = `${back}&ok=${encodeURIComponent(
        `Promotion reversed: ${result.removed} enrollment(s) removed, ${result.reinstated} student(s) reinstated.`)}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not reverse the promotion.')}`;
    }
    redirect(destination);
  }

  return (
    <>
      <h1 className="page-title">Promotion</h1>

      {query.error ? <p className="alert" role="alert">{query.error}</p> : null}
      {query.ok ? <p className="ok" role="status">{query.ok}</p> : null}

      {review ? (
        <>
          <p className="muted">
            {review.batch.status === 'proposed'
              ? 'Review the proposal below. Nothing has moved — and nothing will until the principal commits.'
              : review.batch.status === 'committed'
                ? 'This promotion has been committed. It can still be reversed with a written reason.'
                : 'This promotion was reversed. Nothing from it stands.'}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '16px 0' }}>
            {[['Evaluated', review.summary.evaluated], ['Promote', review.summary.promoted], ['Trial', review.summary.trial],
              ['Repeat', review.summary.repeated], ['Graduate', review.summary.graduated], ['Unresolved', review.summary.unresolved]]
              .map(([label, value]) => (
                <div key={label as string} className="stat">
                  <b style={{ fontSize: 22 }}>{value as number}</b>
                  <span className="muted">{label as string}</span>
                </div>
              ))}
          </div>

          {review.summary.unresolved > 0 ? (
            <p className="alert" role="alert">
              {review.summary.unresolved} student(s) have no published results. They cannot be left unresolved at
              commit — decide each one with a reason.
            </p>
          ) : null}

          {review.batch.status === 'proposed' ? (
            <form action={override} style={{ margin: '16px 0' }}>
              <fieldset>
                <legend className="sub-head">Bulk review</legend>
                <p className="muted">Select students, choose their outcome, and give a reason — &ldquo;why was my child not promoted&rdquo; must be answerable from the record.</p>
                <table className="tbl">
                  <thead>
                    <tr><th></th><th>Student</th><th>From</th><th>To</th><th>Proposed</th><th>Final</th><th>Average</th><th>Passed</th><th>Note</th></tr>
                  </thead>
                  <tbody>
                    {review.decisions.map((d) => (
                      <tr key={d.studentId} style={review.borderline.includes(d.studentId) ? { background: 'var(--warn-bg, #fff7e0)' } : undefined}>
                        <td><input type="checkbox" name="studentIds" value={d.studentId} aria-label={`Select ${d.name}`} /></td>
                        <td>
                          <strong>{d.name}</strong>
                          <span className="muted"> · {d.admissionNumber}</span>
                          {d.overridden ? <span className="muted"><br />Reason: {d.overrideReason}</span> : null}
                        </td>
                        <td>{d.fromClass ?? '—'}</td>
                        <td>{d.toClass ?? '—'}</td>
                        <td>{d.proposedOutcome}</td>
                        <td><strong>{d.finalOutcome}</strong>{d.proposedOutcome !== d.finalOutcome ? ' (overridden)' : ''}</td>
                        <td>{d.averageScore}%</td>
                        <td>{d.subjectsPassed} of {d.subjectsOffered || '—'}</td>
                        <td>{d.note ? d.note.replaceAll('_', ' ') : (review.borderline.includes(d.studentId) ? 'borderline' : '')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                  <label htmlFor="outcome">Outcome</label>
                  <select id="outcome" name="outcome" required>
                    {OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input name="reason" placeholder="Written reason (min 10 characters)" style={{ flex: 1, minWidth: 240 }} required minLength={10} maxLength={255} />
                  <button type="submit">Apply to selected</button>
                </div>
              </fieldset>
            </form>
          ) : (
            <table className="tbl">
              <thead>
                <tr><th>Student</th><th>From</th><th>To</th><th>Final</th><th>Average</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {review.decisions.map((d) => (
                  <tr key={d.studentId}>
                    <td><strong>{d.name}</strong><span className="muted"> · {d.admissionNumber}</span></td>
                    <td>{d.fromClass ?? '—'}</td>
                    <td>{d.toClass ?? '—'}</td>
                    <td><strong>{d.finalOutcome}</strong></td>
                    <td>{d.averageScore}%</td>
                    <td>{d.overrideReason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {review.batch.status === 'proposed' && canCommit ? (
            <form action={commit} style={{ marginTop: 16 }}>
              <button type="submit">Commit promotion</button>
              <p className="muted">Committing writes next session&rsquo;s enrollments (and graduates the graduates). History is never changed.</p>
            </form>
          ) : null}
          {!canCommit && review.batch.status === 'proposed' ? (
            <p className="muted">Only the principal may commit a promotion.</p>
          ) : null}
          {review.batch.status === 'committed' && canCommit ? (
            <form action={reverse} style={{ marginTop: 16 }}>
              <input name="reason" placeholder="Reason for reversing (min 10 characters)" required minLength={10} maxLength={255} style={{ minWidth: 320 }} />
              <button type="submit" className="danger">Reverse promotion</button>
              <p className="muted">Reversing removes only the enrollments this batch wrote and reinstates graduates.</p>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <section style={{ marginBottom: 24 }}>
            <h2 className="sub-head">New proposal</h2>
            <form action={propose}>
              <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', maxWidth: 900 }}>
                <label>From session
                  <select name="fromSessionId" required>
                    {options?.sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </label>
                <label>To session
                  <select name="toSessionId" required>
                    {options?.sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </label>
                <label>Class level
                  <select name="levelId" required>
                    {options?.levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </label>
                <label>Pass mark (%)
                  <input name="passMark" type="number" min={0} max={100} step="0.1" defaultValue={defaults.passMark} />
                </label>
                <label>Promote average (%)
                  <input name="promoteAverage" type="number" min={0} max={100} step="0.1" defaultValue={defaults.promoteAverage} />
                </label>
                <label>Trial average (%)
                  <input name="trialAverage" type="number" min={0} max={100} step="0.1" defaultValue={defaults.trialAverage} />
                </label>
                <label>Min subjects passed
                  <input name="minSubjectsPassed" type="number" min={1} max={20} defaultValue={defaults.minSubjectsPassed} />
                </label>
                <label>Require English &amp; Maths
                  <select name="requireCore" defaultValue="1">
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                </label>
              </div>
              <button type="submit" style={{ marginTop: 10 }}>Evaluate level</button>
              <p className="muted">The proposal is stored, never applied. Every student gets a decision on file, with the annual average taken across all published terms.</p>
            </form>
          </section>

          <section>
            <h2 className="sub-head">Batches</h2>
            {batches.length === 0 ? (
              <p className="muted">No promotion has been proposed yet.</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr><th>From</th><th>To</th><th>Level</th><th>Evaluated</th><th>Summary</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {batches.map(({ batch, levelName, fromTitle, toTitle }) => (
                    <tr key={batch.id}>
                      <td>{fromTitle}</td>
                      <td>{toTitle}</td>
                      <td>{levelName}</td>
                      <td>{batch.totalEvaluated}</td>
                      <td className="muted">
                        {batch.totalPromoted} promote · {batch.totalTrial} trial · {batch.totalRepeated} repeat · {batch.totalGraduated} graduate · {batch.totalUnresolved} unresolved
                      </td>
                      <td><strong>{batch.status}</strong></td>
                      <td><a href={`/portal/promotion?batch=${batch.id}`}>Review</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}
