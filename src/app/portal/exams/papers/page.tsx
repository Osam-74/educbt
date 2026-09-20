import Link from 'next/link';
import { redirect } from 'next/navigation';
import { and, asc, eq, sql } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { listSeries, createSeries, publishSeries, deleteSeries, composeSeries, questionAvailability, paperOverview, deletePaper } from '@/lib/exam/compose';
import { collectionView, saveCollection } from '@/lib/exam/collection';
import { caComponents } from '@/lib/ca/validation';
import { forSchool, schema } from '@/db';
import { PortalIcon } from '../../PortalShell';
import { TYPE_LABEL, STATUS_LABEL, fmtDay, fmtTime, addMinutes } from '../labels';
import DeleteSeriesButton from './DeleteSeriesButton';

export const dynamic = 'force-dynamic';

const DELIVERY_LABEL: Record<string, string> = { cbt: 'CBT', written: 'Written' };

/**
 * Exam Papers (legacy templates/portal/exams/papers.php, $educbt_title = 'Exam Papers').
 *
 * The plugin puts everything on one scrollable page, in this order — see
 * docs/examination-area-parity-todo.md for the full section-by-section
 * breakdown this page was built against:
 *   1. Practice exams notice (practice papers are never scheduled/reviewed —
 *      always available once at least one paper exists).
 *   2. Question bank controller (which single collection teachers may
 *      currently submit into — reuses saveCollection()/collectionView()
 *      from the Question Bank page, not a parallel copy).
 *   3. Continuous assessment tests (live status table — reuses
 *      questionAvailability() from the examination's own page).
 *   4. Open a new assessment window (CA) — createSeries() with
 *      seriesType 'ca_test' and a caComponentKey slot reference.
 *   5. Create examination — createSeries() inline, moved from the old
 *      /portal/exams/new route.
 *   6. All examinations table — every series with Build timetable /
 *      Publish / Delete actions.
 *   7. Submitted papers, pending review — every set awaiting a decision,
 *      with a quick no-comment Approve; sending a set back with a reason
 *      still happens on /portal/exams/approvals, which owns that form.
 */
export default async function ExamPapersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  // The menu hides this link for other roles; the server refuses regardless.
  requireRole(actor, SCHOOL_WIDE);

  const query = await searchParams;
  const series = await listSeries(actor);
  const bank = await collectionView(actor);

  // Section 7 — "Papers": every subject/class paper across every formal
  // examination and CA test, whether composed yet or not (legacy parity:
  // templates/portal/exams/papers.php's own papers table — built from the
  // timetable, composed to pull in the questions, then published or deleted).
  const papers = await paperOverview(actor);

  const { sessions, terms, caSlots } = await forSchool(actor.schoolId, async (tx) => {
    const [school] = await tx.select({ settings: schema.schools.settings })
      .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);
    return {
      sessions: await tx
        .select({ id: schema.academicSessions.id, title: schema.academicSessions.title, isCurrent: schema.academicSessions.isCurrent })
        .from(schema.academicSessions)
        .where(eq(schema.academicSessions.schoolId, actor.schoolId))
        .orderBy(asc(schema.academicSessions.id)),
      terms: await tx
        .select({
          id: schema.terms.id,
          sessionId: schema.terms.sessionId,
          title: schema.terms.title,
          isCurrent: schema.terms.isCurrent,
        })
        .from(schema.terms)
        .where(eq(schema.terms.schoolId, actor.schoolId))
        .orderBy(asc(schema.terms.position)),
      // The office never types "First CA" freehand — the slots come from
      // whatever School Settings configured as non-exam assessment components.
      caSlots: caComponents((school?.settings ?? {}) as Record<string, unknown>),
    };
  });

  async function create(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const created = await createSeries(inner, {
        title: String(formData.get('title') ?? ''),
        seriesType: String(formData.get('seriesType') ?? ''),
        sessionId: String(formData.get('sessionId') ?? ''),
        termId: String(formData.get('termId') ?? ''),
        questionsPerStudent: String(formData.get('questionsPerStudent') ?? ''),
        durationMinutes: String(formData.get('durationMinutes') ?? ''),
        questionsOpenFrom: formData.get('questionsOpenFrom') || null,
        questionsOpenTo: formData.get('questionsOpenTo') || null,
        assessmentMode: String(formData.get('assessmentMode') ?? 'mixed'),
      });

      destination = `/portal/exams/${Number(created.id)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The examination could not be created.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    // Outside the try/catch: redirect() throws, and catching it would turn the
    // success path into the error page.
    redirect(destination);
  }

  async function publish(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);
    const seriesId = Number(formData.get('seriesId'));

    let destination: string;

    try {
      const count = await publishSeries(inner, seriesId);
      destination = `/portal/exams/papers?ok=${encodeURIComponent(`Published ${count} paper(s).`)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not publish this examination.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    // Outside the try/catch: redirect() throws, and a catch around it turns
    // a successful publish into a bogus error banner (same footgun as create()).
    redirect(destination);
  }

  async function openBankFor(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    let destination: string;

    try {
      const current = await collectionView(inner);
      await saveCollection(inner, {
        seriesId: formData.get('seriesId') || null,
        objective: current.config.objective,
        theory: current.config.theory,
      });
      destination = '/portal/exams/papers?ok=' + encodeURIComponent('Question bank updated.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not update the question bank.';
      destination = '/portal/exams/papers?error=' + encodeURIComponent(message);
    }

    // Outside the try/catch: redirect() throws, and catching it would turn the
    // success path into the error page (see create() above — the same footgun).
    redirect(destination);
  }

  async function openCaWindow(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);

    const slotKey = String(formData.get('caComponentKey') ?? '');
    const school = await forSchool(inner.schoolId, async (tx) => {
      const [row] = await tx.select({ settings: schema.schools.settings })
        .from(schema.schools).where(eq(schema.schools.id, inner.schoolId)).limit(1);
      return row;
    });
    const slot = caComponents((school?.settings ?? {}) as Record<string, unknown>)
      .find((c) => c.key === slotKey);

    const rawTitle = String(formData.get('title') ?? '').trim();
    // "Name (optional — defaults from the slot if left blank)" per the plugin.
    const title = rawTitle || slot?.label || 'Continuous assessment';

    const currentSession = (await forSchool(inner.schoolId, async (tx) =>
      tx.select({ id: schema.academicSessions.id })
        .from(schema.academicSessions)
        .where(and(eq(schema.academicSessions.schoolId, inner.schoolId), eq(schema.academicSessions.isCurrent, true)))
        .limit(1)))[0];
    const currentTerm = (await forSchool(inner.schoolId, async (tx) =>
      tx.select({ id: schema.terms.id })
        .from(schema.terms)
        .where(and(eq(schema.terms.schoolId, inner.schoolId), eq(schema.terms.isCurrent, true)))
        .limit(1)))[0];

    let destination: string;

    try {
      if (!currentSession || !currentTerm) {
        throw new Error('Set a current academic session and term in School Settings before opening a CA window.');
      }

      await createSeries(inner, {
        title,
        seriesType: 'ca_test',
        sessionId: String(currentSession.id),
        termId: String(currentTerm.id),
        caComponentKey: slotKey || null,
        questionsPerStudent: String(formData.get('questionsPerStudent') ?? ''),
        durationMinutes: String(formData.get('durationMinutes') ?? ''),
        questionsOpenFrom: formData.get('questionsOpenFrom') || null,
        questionsOpenTo: formData.get('questionsOpenTo') || null,
        assessmentMode: String(formData.get('assessmentMode') ?? 'mixed'),
      });
      destination = '/portal/exams/papers?ok=' + encodeURIComponent(`"${title}" is open for teachers to set questions into.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not open that assessment window.';
      destination = '/portal/exams/papers?error=' + encodeURIComponent(message);
    }

    // Outside the try/catch — see create() above for why.
    redirect(destination);
  }

  async function composeCaSeries(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);
    const seriesId = Number(formData.get('seriesId'));

    let destination: string;

    try {
      const result = await composeSeries(inner, seriesId);
      const message = result.short.length > 0
        ? `Composed ${result.created} paper(s). Still short of questions: ${result.short.join('; ')}.`
        : `Composed ${result.created} paper(s).`;
      destination = `/portal/exams/papers?ok=${encodeURIComponent(message)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not compose that assessment.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    // Outside the try/catch — see create() above for why.
    redirect(destination);
  }

  async function composePapers(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);
    const seriesId = Number(formData.get('seriesId'));

    let destination: string;

    try {
      const result = await composeSeries(inner, seriesId);
      destination = result.short.length > 0
        ? `/portal/exams/papers?error=${encodeURIComponent(`Composed ${result.created} paper(s). Still short of questions: ${result.short.join('; ')}.`)}`
        : `/portal/exams/papers?ok=${encodeURIComponent(`Composed ${result.created} paper(s).`)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not compose this paper.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    redirect(destination);
  }

  async function publishPapers(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);
    const seriesId = Number(formData.get('seriesId'));

    let destination: string;

    try {
      const count = await publishSeries(inner, seriesId);
      destination = `/portal/exams/papers?ok=${encodeURIComponent(`Published ${count} paper(s). Ready for CBT.`)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not publish this paper.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    redirect(destination);
  }

  async function removePaper(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);
    const paperId = Number(formData.get('paperId'));

    let destination: string;

    try {
      await deletePaper(inner, paperId);
      destination = `/portal/exams/papers?ok=${encodeURIComponent('Paper deleted.')}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not delete this paper.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    redirect(destination);
  }

  async function remove(formData: FormData) {
    'use server';

    const inner = await requireSchoolSession();
    requireRole(inner, SCHOOL_WIDE);
    const seriesId = Number(formData.get('seriesId'));

    let destination: string;

    try {
      await deleteSeries(inner, seriesId);
      destination = `/portal/exams/papers?ok=${encodeURIComponent('Examination deleted.')}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not delete this examination.';
      destination = `/portal/exams/papers?error=${encodeURIComponent(message)}`;
    }

    // Outside the try/catch — same footgun as publish()/create() above.
    redirect(destination);
  }

  const defaultSession = sessions.find((s) => s.isCurrent) ?? sessions[0];
  const defaultTerm = terms.find((t) => t.isCurrent && t.sessionId === defaultSession?.id) ?? terms[0];
  const practiceSeries = series.filter((s) => s.seriesType === 'practice' && s.paperCount > 0);
  const sessionTitleById = new Map(sessions.map((s) => [s.id, s.title]));
  const termTitleById = new Map(terms.map((t) => [t.id, t.title]));
  const bankOpenFor = bank.series.find((s) => s.id === bank.config.seriesId);
  const bankCandidates = bank.series.filter((s) => s.seriesType !== 'practice' && ['draft', 'open'].includes(s.status));

  // Section 3 — "Continuous assessment tests": every CA test still in play
  // (not yet published/closed/cancelled), with a live submitted/total papers
  // count. Runs the exact same availability query the office would see on
  // the examination's own page, so this table can never disagree with it.
  const activeCaSeries = series.filter((s) => s.seriesType === 'ca_test' && !['published', 'closed', 'cancelled'].includes(s.status));
  const caSlotLabelByKey = new Map(caSlots.map((c) => [c.key, c.label]));
  const activeCaTests = await Promise.all(activeCaSeries.map(async (s) => {
    const availability = await questionAvailability(actor, s.id);
    return {
      ...s,
      componentLabel: s.caComponentKey ? caSlotLabelByKey.get(s.caComponentKey) ?? s.caComponentKey : null,
      perStudent: availability.perStudent,
      submitted: availability.rows.filter((r) => r.ready).length,
      totalPapers: availability.rows.length,
    };
  }));

  return (
    <div className="school-dashboard">
      <div className="sd-heading">
        <div>
          <p className="sd-eyebrow">Examination office</p>
          <h1>Exam Papers</h1>
        </div>
      </div>

      {query.error ? <p className="error" style={{ marginBottom: 16 }}>{query.error}</p> : null}
      {query.ok ? <p className="ok" style={{ marginBottom: 16 }}>{query.ok}</p> : null}

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="tests" />Practice exams</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {practiceSeries.length === 0 ? (
            <p className="muted" style={{ margin: '10px 0 0' }}>
              No practice papers yet. Choose "Practice" as the type below to start one.
            </p>
          ) : (
            <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
              {practiceSeries.map((p) => (
                <li key={p.id}>
                  <a href={`/portal/exams/${p.id}`}>{p.title}</a>
                  {' — '}
                  {p.paperCount} paper{p.paperCount === 1 ? '' : 's'}, always available
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="questions" />Question bank controller</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          <p style={{ margin: '10px 0 0' }}>
            Currently open: {bankOpenFor
              ? <strong>{bankOpenFor.title}</strong>
              : <span className="muted">Nothing — the bank is closed</span>}
          </p>
          <form action={openBankFor} className="eo-mini-form" style={{ marginTop: 10 }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Open for
              <select name="seriesId" defaultValue={bank.config.seriesId ?? ''}>
                <option value="">Close the bank</option>
                {bankCandidates.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="sd-action sd-action--ghost">Apply</button>
          </form>
        </div>
      </section>

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="tests" />Continuous assessment tests</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {activeCaTests.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>
              No CA test is open right now. Use "Open a new assessment window" below to start one.
            </p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th><th>Counts towards</th><th>Questions per student</th>
                    <th>Papers</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {activeCaTests.map((s) => (
                    <tr key={s.id}>
                      <td>{s.title}</td>
                      <td className="muted">{s.componentLabel ?? '—'}</td>
                      <td>{s.perStudent}</td>
                      <td>{s.submitted} of {s.totalPapers}</td>
                      <td>{STATUS_LABEL[s.status] ?? s.status}</td>
                      <td style={{ display: 'flex', gap: 8 }}>
                        <form action={composeCaSeries}>
                          <input type="hidden" name="seriesId" value={s.id} />
                          <button type="submit" className="sd-action sd-action--ghost" style={{ padding: '3px 10px', fontSize: 12.5 }} disabled={s.totalPapers === 0}>
                            Compose
                          </button>
                        </form>
                        {s.paperCount > 0 ? (
                          <a href={`/portal/timetable?series=${s.id}`} className="sd-action sd-action--ghost" style={{ padding: '3px 10px', fontSize: 12.5 }}>
                            Build timetable
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="tests" />Open a new assessment window (CA)</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {caSlots.length === 0 ? (
            <p className="muted" style={{ margin: '10px 0' }}>
              No continuous-assessment slots are configured yet. Add one (e.g.
              "First CA") in School Settings before opening a window.
            </p>
          ) : (
            <form action={openCaWindow} className="eo-mini-form" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Counts towards
                  <select name="caComponentKey" required>
                    {caSlots.map((c) => (
                      <option key={c.key} value={c.key}>{c.label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Name (optional)
                  <input name="title" maxLength={191} placeholder="Defaults to the slot's name" />
                </label>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Assessment mode
                  <select name="assessmentMode" defaultValue="mixed">
                    <option value="mixed">Mixed — each teacher chooses CBT or Written</option>
                    <option value="cbt">CBT — every subject is a CBT test</option>
                    <option value="written">Written — every subject is on paper</option>
                  </select>
                </label>
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Question window opens
                  <input name="questionsOpenFrom" type="date" />
                </label>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Question window closes
                  <input name="questionsOpenTo" type="date" />
                </label>
              </div>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Questions per student
                  <input name="questionsPerStudent" type="number" min="1" max="200" defaultValue={20} required />
                </label>
                <label style={{ flex: 1, minWidth: 220 }}>
                  Duration (minutes)
                  <input name="durationMinutes" type="number" min="5" max="300" placeholder="e.g. 30" required />
                </label>
              </div>

              <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Open assessment window</button>
            </form>
          )}
        </div>
      </section>

      <section className="sd-panel sd-panel--wide" style={{ marginBottom: 22 }}>
        <header><h2><PortalIcon name="exam" />Create examination</h2></header>
        <form action={create} className="eo-mini-form" style={{ flexDirection: 'column', alignItems: 'stretch', padding: '0 22px 20px' }}>
          <label>
            Name
            <input name="title" required maxLength={191} placeholder="e.g. First Term Examination 2026/2027" />
          </label>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Type
              <select name="seriesType" defaultValue="examination" required>
                <option value="examination">Examination — terminal, reviewed, timetabled</option>
                <option value="ca_test">CA Test — continuous assessment, timetabled</option>
                <option value="practice">Practice — for revision, always available</option>
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Academic session
              <select name="sessionId" defaultValue={defaultSession?.id} required>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.title}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Term
              <select name="termId" defaultValue={defaultTerm?.id} required>
                {terms.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Questions per paper
              <input name="questionsPerStudent" type="number" min="1" max="200" defaultValue={40} required />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Duration (minutes)
              <input name="durationMinutes" type="number" min="5" max="300" placeholder="e.g. 60" required />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Assessment mode
              <select name="assessmentMode" defaultValue="mixed">
                <option value="mixed">Mixed — each teacher chooses CBT or Written</option>
                <option value="cbt">CBT — every subject is a CBT test</option>
                <option value="written">Written — every subject is on paper</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: 220 }}>
              Teachers submit questions from (optional)
              <input name="questionsOpenFrom" type="date" />
            </label>
            <label style={{ flex: 1, minWidth: 220 }}>
              Teachers submit questions until (optional)
              <input name="questionsOpenTo" type="date" />
            </label>
          </div>

          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
            The sitting dates are not set here. They are set on the timetable once the papers exist.
          </p>

          <button type="submit" className="sd-action" style={{ alignSelf: 'flex-start' }}>Create examination</button>
        </form>
      </section>

      <section className="sd-panel sd-panel--wide">
        <header><h2><PortalIcon name="papers" />All examinations</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {series.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>
              No examinations yet. Use the form above to start the first one.
            </p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th><th>Type</th><th>Session/Term</th><th>Papers</th>
                    <th>Q-Bank window</th><th>Sitting window</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {series.map((s) => (
                    <tr key={s.id}>
                      <td>{s.title}</td>
                      <td>{TYPE_LABEL[s.seriesType] ?? s.seriesType}</td>
                      <td className="muted">
                        {(s.sessionId ? sessionTitleById.get(s.sessionId) : null) ?? '—'}
                        {' / '}
                        {(s.termId ? termTitleById.get(s.termId) : null) ?? '—'}
                      </td>
                      <td>
                        {s.paperCount}
                        {s.paperCount > 0 && s.unscheduledCount > 0 && s.seriesType !== 'practice' ? (
                          <span className="tag">{' '}{s.unscheduledCount} unscheduled</span>
                        ) : null}
                      </td>
                      <td className="muted">
                        {s.questionsOpenFrom && s.questionsOpenTo
                          ? `${fmtDay(s.questionsOpenFrom)} – ${fmtDay(s.questionsOpenTo)}`
                          : 'Not set'}
                      </td>
                      <td>
                        {s.seriesType === 'practice' ? (
                          <span className="muted">Always available</span>
                        ) : (
                          `${fmtDay(s.sittingOpensAt)} – ${fmtDay(s.sittingClosesAt)}`
                        )}
                      </td>
                      <td>
                        <span className={`pill pill--${
                          s.status === 'published' ? 'published'
                            : s.status === 'draft' ? 'draft'
                              : 'submitted'
                        }`}>
                          {STATUS_LABEL[s.status] ?? s.status}
                        </span>
                      </td>
                      <td style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <a href={`/portal/exams/${s.id}`}>Open</a>
                        {s.paperCount > 0 ? (
                          <a href={`/portal/timetable?series=${s.id}`}>Build timetable</a>
                        ) : null}
                        {s.status !== 'published' && s.paperCount > 0 ? (
                          <form action={publish} style={{ display: 'inline' }}>
                            <input type="hidden" name="seriesId" value={s.id} />
                            <button type="submit" className="sd-action sd-action--ghost" style={{ padding: '3px 10px', fontSize: 12.5 }}>
                              Publish
                            </button>
                          </form>
                        ) : null}
                        {s.status === 'draft' ? (
                          <form action={remove} style={{ display: 'inline' }}>
                            <input type="hidden" name="seriesId" value={s.id} />
                            <DeleteSeriesButton title={s.title} />
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="sd-panel sd-panel--wide" style={{ marginTop: 22 }}>
        <header><h2><PortalIcon name="papers" />Papers ({papers.length})</h2></header>
        <div style={{ padding: '0 22px 20px' }}>
          {papers.length === 0 ? (
            <p className="muted" style={{ margin: '18px 0' }}>
              No papers yet. Build the timetable for an examination or CA test above to
              create them.
            </p>
          ) : (
            <div className="sd-table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Subject</th><th>Class</th><th>Type</th><th>When</th>
                    <th>Questions</th><th>Invigilator</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {papers.map((p) => (
                    <tr key={p.key}>
                      <td>{p.subjectName}</td>
                      <td className="muted">{p.levelName ?? '—'}</td>
                      <td>{DELIVERY_LABEL[p.deliveryMode] ?? p.deliveryMode}</td>
                      <td className="muted">
                        {p.scheduledAt
                          ? `${fmtDay(p.scheduledAt)}, ${fmtTime(p.scheduledAt)}–${fmtTime(addMinutes(p.scheduledAt, (p.durationSeconds ?? 3600) / 60))}`
                          : 'Not on the timetable yet'}
                      </td>
                      <td>{p.status === 'not_composed' ? 'Not composed' : p.questionCount}</td>
                      <td className="muted">{p.invigilatorName ?? 'Not assigned'}</td>
                      <td>
                        {p.status === 'published' ? <span className="pill pill--published">Published</span>
                          : p.status === 'draft' ? <span className="pill pill--approved">Ready</span>
                            : <span className="pill pill--draft">Draft</span>}
                      </td>
                      <td style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        {p.status === 'not_composed' ? (
                          <form action={composePapers} style={{ display: 'inline' }}>
                            <input type="hidden" name="seriesId" value={p.seriesId} />
                            <button type="submit" className="sd-action sd-action--ghost" style={{ padding: '3px 10px', fontSize: 12.5 }}>
                              Compose
                            </button>
                          </form>
                        ) : null}
                        {p.status === 'draft' ? (
                          <>
                            <form action={publishPapers} style={{ display: 'inline' }}>
                              <input type="hidden" name="seriesId" value={p.seriesId} />
                              <button type="submit" className="sd-action sd-action--ghost" style={{ padding: '3px 10px', fontSize: 12.5 }}>
                                Publish
                              </button>
                            </form>
                            <form action={removePaper} style={{ display: 'inline' }}>
                              <input type="hidden" name="paperId" value={p.paperId ?? ''} />
                              <button type="submit" className="sd-action sd-action--ghost" style={{ padding: '3px 10px', fontSize: 12.5 }}>
                                Delete
                              </button>
                            </form>
                          </>
                        ) : null}
                        {p.status === 'published' ? (
                          <Link href={`/portal/exams/${p.seriesId}`}>View</Link>
                        ) : null}
                      </td>
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
