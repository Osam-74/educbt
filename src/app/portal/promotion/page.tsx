import { redirect } from 'next/navigation';
import { and, asc, eq } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import {
  canRunPromotion, canCommitPromotion, defaultRules,
  proposePromotion, promotionBatches, promotionReview,
  overridePromotion, commitPromotion, reversePromotion,
  searchPromotionStudents, moveStudent, promotionRulesFor, savePromotionRules,
} from '@/lib/promotion/promotion';
import ChipSelect from './ChipSelect';
import '../school-table.css';

export const dynamic = 'force-dynamic';

const OUTCOMES = [['promote', 'Promote'], ['trial', 'Trial'], ['repeat', 'Repeat'], ['graduate', 'Graduate']] as const;

/**
 * Promotion office (legacy EduCBT Pro parity: templates/portal/school/promotion.php).
 * The plugin's four blocks, in its order: an individual move search, the
 * batch proposal form, per-level promotion rules (with the must-pass subject
 * pill picker), and — for an open batch — the four summary numbers, the
 * exceptions that need a human, and the commit button.
 */
export default async function PromotionPage({
  searchParams,
}: {
  searchParams: Promise<{ batch?: string; sq?: string; rules_level?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  if (!canRunPromotion(actor)) redirect('/portal');
  const query = await searchParams;
  const canCommit = canCommitPromotion(actor);

  const batchId = Number(query.batch) || 0;
  const review = batchId ? await promotionReview(actor, batchId).catch(() => null) : null;
  const batches = await promotionBatches(actor);

  const search = (query.sq ?? '').trim();
  const found = search ? await searchPromotionStudents(actor, search) : [];

  const options = review ? null : await forSchool(actor.schoolId, async (tx) => ({
    sessions: await tx.select({ id: schema.academicSessions.id, title: schema.academicSessions.title })
      .from(schema.academicSessions).where(eq(schema.academicSessions.schoolId, actor.schoolId))
      .orderBy(asc(schema.academicSessions.title)),
    levels: await tx.select({ id: schema.classLevels.id, name: schema.classLevels.name })
      .from(schema.classLevels).where(eq(schema.classLevels.schoolId, actor.schoolId))
      .orderBy(asc(schema.classLevels.levelOrder)),
    classes: await tx.select({ id: schema.classes.id, displayName: schema.classes.displayName })
      .from(schema.classes).where(and(eq(schema.classes.schoolId, actor.schoolId), eq(schema.classes.status, 'active')))
      .orderBy(asc(schema.classes.displayName)),
    subjects: await tx.select({ name: schema.subjects.name, code: schema.subjects.code })
      .from(schema.subjects).where(and(eq(schema.subjects.schoolId, actor.schoolId), eq(schema.subjects.status, 'active')))
      .orderBy(asc(schema.subjects.name)),
  }));

  const rulesLevelId = Number(query.rules_level) || options?.levels[0]?.id || 0;
  const savedRules = rulesLevelId ? await promotionRulesFor(actor, rulesLevelId).catch(() => defaultRules()) : defaultRules();

  async function propose(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    let destination: string;
    try {
      const result = await proposePromotion(inner, {
        fromSessionId: Number(formData.get('fromSessionId')),
        toSessionId: Number(formData.get('toSessionId')),
        levelId: Number(formData.get('levelId')),
      });
      destination = `/portal/promotion?batch=${result.batchId}&ok=${encodeURIComponent(
        `Proposal created: ${result.summary.promoted} promoted, ${result.summary.trial} on trial, ${result.summary.repeated} repeating, ${result.summary.graduated} graduating, ${result.summary.unresolved} unresolved.`)}`;
    } catch (error) {
      destination = `/portal/promotion?error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not create the proposal.')}`;
    }
    redirect(destination);
  }

  async function move(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/promotion?sq=${encodeURIComponent(String(formData.get('sq') ?? ''))}`;
    let destination: string;
    try {
      await moveStudent(inner, {
        studentId: Number(formData.get('studentId')),
        toClassId: Number(formData.get('toClassId')),
        outcome: String(formData.get('outcome') ?? ''),
        reason: String(formData.get('reason') ?? ''),
      });
      destination = `${back}&ok=${encodeURIComponent('Student moved. The change is recorded in the activity log.')}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not move that student.')}`;
    }
    redirect(destination);
  }

  async function saveRules(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const levelId = Number(formData.get('levelId'));
    const back = `/portal/promotion?rules_level=${levelId}`;
    let destination: string;
    try {
      await savePromotionRules(inner, levelId, {
        passMark: Number(formData.get('passMark')),
        promoteAverage: Number(formData.get('promoteAverage')),
        trialAverage: Number(formData.get('trialAverage')),
        minSubjectsPassed: Number(formData.get('minSubjectsPassed')),
        mustPassCodes: formData.getAll('mustPassCodes').map(String),
        requireCore: formData.get('requireCore') === '1',
      });
      destination = `${back}&ok=${encodeURIComponent('Promotion rules saved for this level.')}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not save the rules.')}`;
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
      for (const id of ids) await overridePromotion(inner, batchId, id, outcome, reason);
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

  const exceptions = review
    ? review.decisions.filter(d => d.finalOutcome === 'unresolved' || review.borderline.includes(d.studentId) || d.proposedOutcome !== d.finalOutcome)
    : [];

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

          <div className="stat-grid">
            <div className="stat"><b>{review.summary.promoted}</b><span>Promoted</span></div>
            <div className="stat"><b>{review.summary.trial}</b><span>On trial</span></div>
            <div className="stat"><b>{review.summary.repeated}</b><span>Repeating</span></div>
            <div className="stat"><b>{review.summary.unresolved}</b><span>Unresolved</span></div>
          </div>

          <section className="card">
            <h2 className="sub-head">Needs a decision <span className="muted">({exceptions.length} of {review.summary.evaluated})</span></h2>
            {exceptions.length === 0 ? <p className="muted">Every student is clear-cut.</p> : (
              <table className="tbl">
                <thead><tr><th>Student</th><th>Average</th><th>Passed</th><th>Proposed</th><th>Override</th></tr></thead>
                <tbody>
                  {exceptions.map(d => <tr key={d.studentId} style={review.borderline.includes(d.studentId) ? { background: 'var(--warn-bg, #fff7e0)' } : undefined}>
                    <td><strong>{d.name}</strong><br /><span className="muted">{d.admissionNumber}</span></td>
                    <td>{d.averageScore}%</td>
                    <td>{d.subjectsPassed} of {d.subjectsOffered || '—'}</td>
                    <td><span className="pill">{d.proposedOutcome}</span></td>
                    <td>
                      <form action={override} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input type="hidden" name="studentIds" value={d.studentId} />
                        <select name="outcome" aria-label={'Outcome for ' + d.name}>
                          {OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <input name="reason" type="text" placeholder="Reason" required maxLength={255} style={{ width: 130 }} />
                        <button type="submit">Set</button>
                      </form>
                    </td>
                  </tr>)}
                </tbody>
              </table>
            )}
          </section>

          <section className="card">
            <h2 className="sub-head">Every student in the proposal</h2>
            <table className="tbl">
              <thead><tr><th>Student</th><th>From</th><th>To</th><th>Proposed</th><th>Final</th><th>Average</th><th>Note</th></tr></thead>
              <tbody>
                {review.decisions.map(d => <tr key={d.studentId}>
                  <td><strong>{d.name}</strong><span className="muted"> · {d.admissionNumber}</span>
                    {d.overrideReason ? <span className="muted"><br />Reason: {d.overrideReason}</span> : null}</td>
                  <td>{d.fromClass ?? '—'}</td>
                  <td>{d.toClass ?? '—'}</td>
                  <td>{d.proposedOutcome}</td>
                  <td><span className="pill">{d.finalOutcome}</span></td>
                  <td>{d.averageScore}%</td>
                  <td>{d.note ? d.note.replaceAll('_', ' ') : ''}</td>
                </tr>)}
              </tbody>
            </table>
          </section>

          {review.batch.status === 'proposed' && canCommit ? (
            <form action={commit} className="card">
              <h2 className="sub-head">Commit</h2>
              <button type="submit" className="primary">Commit promotion</button>
              <p className="muted">Committing writes next session&rsquo;s enrollments (and graduates the graduates). History is never changed.</p>
            </form>
          ) : null}
          {!canCommit && review.batch.status === 'proposed' ? <p className="muted">Only the principal may commit a promotion.</p> : null}
          {review.batch.status === 'committed' && canCommit ? (
            <form action={reverse} className="card">
              <h2 className="sub-head">Reverse</h2>
              <input name="reason" placeholder="Reason for reversing (min 10 characters)" required minLength={10} maxLength={255} style={{ minWidth: 320 }} />
              <button type="submit" className="danger">Reverse promotion</button>
              <p className="muted">Reversing removes only the enrollments this batch wrote and reinstates graduates.</p>
            </form>
          ) : null}
        </>
      ) : (
        <>
          <section className="card">
            <h2 className="sub-head">Promote or demote a student individually</h2>
            <p className="muted">Search by name or admission number. Move a student to any class without running a full batch — for late joiners, mid-year transfers, or corrections.</p>
            <form method="get" className="search-row">
              <label htmlFor="sq" className="sr-only">Search student</label>
              <input id="sq" name="sq" type="text" defaultValue={search} placeholder="Name or admission number" style={{ flex: 1, minWidth: 240 }} />
              <button type="submit">Search</button>
            </form>

            {search !== '' ? (found.length === 0 ? <p className="muted">No student matched.</p> : (
              <table className="tbl">
                <thead><tr><th>Adm. no.</th><th>Name</th><th>Current class</th><th>Status</th><th>Move to</th></tr></thead>
                <tbody>
                  {found.map(s => <tr key={s.id}>
                    <td><code>{s.admissionNumber}</code></td>
                    <td>{s.name}</td>
                    <td>{s.className ?? 'Not enrolled'}</td>
                    <td className="muted" style={{ textTransform: 'capitalize' }}>{s.status}</td>
                    <td>
                      <form action={move} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input type="hidden" name="studentId" value={s.id} />
                        <input type="hidden" name="sq" value={search} />
                        <label className="sr-only" htmlFor={'toClass-' + s.id}>Target class</label>
                        <select id={'toClass-' + s.id} name="toClassId" required style={{ minWidth: 140 }}>
                          <option value="">Select class</option>
                          {options?.classes.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                        </select>
                        <label className="sr-only" htmlFor={'outcome-' + s.id}>Outcome</label>
                        <select id={'outcome-' + s.id} name="outcome" required>
                          {OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                        <input name="reason" type="text" placeholder="Reason" required maxLength={255} style={{ width: 120 }} />
                        <button type="submit" className="primary">Move</button>
                      </form>
                    </td>
                  </tr>)}
                </tbody>
              </table>
            )) : null}
          </section>

          <section className="card sa-card">
            <h2 className="sub-head">Run a promotion</h2>
            <p className="muted">Every student in the level is scored against the rules and a proposal is produced. <strong>Nothing moves until you commit it.</strong></p>
            <form action={propose}>
              <fieldset className="sa-grid" style={{ border: 0, padding: 0, margin: 0 }}>
                <div>
                  <label htmlFor="propose_level">Level</label>
                  <select id="propose_level" name="levelId" required>
                    <option value="">Choose</option>
                    {options?.levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="propose_from">From session</label>
                  <select id="propose_from" name="fromSessionId" required>
                    {options?.sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="propose_to">Into session</label>
                  <select id="propose_to" name="toSessionId" required>
                    {options?.sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                  <small className="muted">Add next year&rsquo;s session under Settings first.</small>
                </div>
              </fieldset>
              <button type="submit" className="sa-btn sa-btn--primary" style={{ marginTop: 16 }}>Produce a proposal</button>
            </form>
          </section>

          {/* The plugin renders this card unconditionally (promotion.php:182) —
              a school with no class levels yet still sees the rules form, with an
              empty level select. Our old levels.length gate hid the whole card,
              which read as "promotion rules are missing" on a fresh school. */}
          <section className="card sa-card">
              <h2 className="sub-head">Promotion rules</h2>
              <p className="muted">Set per level, so JSS3 can differ from SS2. Proposals use these rules for the chosen level.</p>
              <form method="get" className="sa-toolbar" style={{ marginBottom: 18 }}>
                <div className="sa-field">
                  <label htmlFor="rules_level">Level</label>
                  <select id="rules_level" name="rules_level" defaultValue={String(rulesLevelId)}>
                    {(options?.levels.length ?? 0) === 0 && <option value="0">No class levels yet — create classes first</option>}
                    {options?.levels.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
                <button type="submit" className="sa-btn sa-btn--primary">Load</button>
              </form>
              <form action={saveRules}>
                <input type="hidden" name="levelId" value={rulesLevelId} />
                {rulesLevelId === 0 && <p className="muted">Create classes (with levels) first — rules save against a level, exactly as the plugin does.</p>}
                <fieldset className="sa-grid" style={{ border: 0, padding: 0, margin: '0 0 4px' }}>
                  <div>
                    <label htmlFor="rules_promote">Promote at average (%)</label>
                    <input id="rules_promote" name="promoteAverage" type="number" step="0.5" min="0" max="100" defaultValue={savedRules.promoteAverage} />
                  </div>
                  <div>
                    <label htmlFor="rules_trial">On trial at average (%)</label>
                    <input id="rules_trial" name="trialAverage" type="number" step="0.5" min="0" max="100" defaultValue={savedRules.trialAverage} />
                  </div>
                  <div>
                    <label htmlFor="rules_passmark">A subject is passed at (%)</label>
                    <input id="rules_passmark" name="passMark" type="number" step="0.5" min="0" max="100" defaultValue={savedRules.passMark} />
                  </div>
                  <div>
                    <label htmlFor="rules_minsubjects">Subjects that must be passed</label>
                    <input id="rules_minsubjects" name="minSubjectsPassed" type="number" min="1" max="20" defaultValue={savedRules.minSubjectsPassed} />
                    <small className="muted">Capped at the number a student actually offers.</small>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <span className="field-label">Subjects that must be passed</span>
                    <ChipSelect name="mustPassCodes" selected={savedRules.mustPassCodes}
                      options={(options?.subjects ?? []).map(s => ({ value: s.code, label: `${s.name} (${s.code})` }))}
                      placeholder="Click to select subjects…" />
                    <small className="muted">Failing any of these means repeating the year, whatever the average.</small>
                  </div>
                </fieldset>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 400 }}>
                  <input type="checkbox" name="requireCore" value="1" defaultChecked={savedRules.requireCore} style={{ width: 'auto' }} />
                  Enforce the compulsory subjects
                </label>
                <button type="submit" className="sa-btn sa-btn--primary" style={{ marginTop: 4 }}>Save rules</button>
              </form>
          </section>

          <section className="card">
            <h2 className="sub-head">Recent batches</h2>
            {batches.length === 0 ? <p className="muted">No promotion has been proposed yet.</p> : (
              <ul className="batch-list">
                {batches.map(({ batch, levelName, fromTitle, toTitle }) => <li key={batch.id}>
                  <span>Batch #{batch.id} — {levelName} · {fromTitle} → {toTitle} · {batch.totalEvaluated} students</span>
                  <span className="pill">{batch.status}</span>
                  <a href={`/portal/promotion?batch=${batch.id}`}>Review</a>
                </li>)}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
