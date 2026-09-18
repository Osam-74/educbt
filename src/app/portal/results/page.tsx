import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { canManageResults, resultConfig } from '@/lib/results/config';
import { ClassRow } from './ClassRow';
import './results.css';

export const dynamic = 'force-dynamic';

/**
 * Results — ported from the plugin's school/results.php: for the current
 * session and term, one table row per class showing its stage, how many of
 * its students are compiled, and the per-class actions (Compile / Recompile,
 * Review & Moderate, the forward lifecycle step, Broadsheet). Compiling
 * works out totals, grades and positions; nothing reaches a student or
 * parent until it has been signed off and then published.
 */
export default async function ResultsPage() {
  const actor = await requireSchoolSession();
  if (!canManageResults(actor)) {
    return <><h1 className="page-title">Results</h1><p>You do not have access to the results dashboard.</p></>;
  }

  const data = await forSchool(actor.schoolId, async (tx) => {
    const classes = await tx.select().from(schema.classes)
      .where(eq(schema.classes.status, 'active'))
      .orderBy(asc(schema.classes.displayName));

    const [term] = await tx.select().from(schema.terms)
      .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.isCurrent, true))).limit(1);

    const [school] = await tx.select({ settings: schema.schools.settings })
      .from(schema.schools).where(eq(schema.schools.id, actor.schoolId)).limit(1);

    const config = term ? resultConfig((school?.settings as Record<string, unknown>) ?? {}) : null;
    if (!term) return { classes: [], term: null, session: null, rows: [], config };

    const [session] = await tx.select({ title: schema.academicSessions.title })
      .from(schema.academicSessions).where(eq(schema.academicSessions.id, term.sessionId)).limit(1);

    const enrolled = await tx.select({ classId: schema.enrollments.classId, studentId: schema.enrollments.studentId })
      .from(schema.enrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(
        eq(schema.enrollments.sessionId, term.sessionId),
        eq(schema.enrollments.status, 'active'),
        eq(schema.students.status, 'active'),
      ));

    const byClass = new Map<number, number[]>();
    for (const e of enrolled) {
      const cid = Number(e.classId);
      if (!byClass.has(cid)) byClass.set(cid, []);
      byClass.get(cid)!.push(Number(e.studentId));
    }

    const allIds = [...new Set(enrolled.map((e) => Number(e.studentId)))];
    const results = allIds.length
      ? await tx.select({
          studentId: subjectResults.studentId, state: subjectResults.state,
          complete: subjectResults.complete,
        }).from(subjectResults).where(and(
          eq(subjectResults.schoolId, actor.schoolId),
          eq(subjectResults.sessionId, term.sessionId),
          eq(subjectResults.termId, term.id),
          inArray(subjectResults.studentId, allIds),
        ))
      : [];

    const rows = classes.map((c) => {
      const ids = new Set(byClass.get(Number(c.id)) ?? []);
      const own = results.filter((r) => ids.has(Number(r.studentId)));
      const states = [...new Set(own.map((r) => r.state))];
      // Two different nothings: a class with nobody in it, and a class whose
      // students have not been compiled. Showing "0" for both was the
      // confusing part (results.php, Students column).
      const compiled = new Set(own.filter((r) => r.complete && r.state !== 'draft').map((r) => Number(r.studentId))).size;
      return {
        classId: Number(c.id),
        displayName: c.displayName,
        enrolled: ids.size,
        compiled,
        stage: own.length === 0 ? '' : states.length > 1 ? 'mixed' : states[0]!,
      };
    });

    return { classes: rows, term, session: session ?? null, rows, config };
  });

  const principal = actor.role === 'principal';

  if (!data.term) {
    return <><h1 className="page-title">Results</h1>
      <section className="card"><p className="note">No current term is set.</p></section></>;
  }

  return <div className="results-page">
    <h1 className="page-title">Results</h1>
    <p className="muted">{data.session?.title ?? ''} · {data.term.title}</p>

    <section className="card">
      <h2 className="sub-head">Classes</h2>

      {data.classes.length === 0 ? <p className="muted">No classes yet.</p> : <>
        <div className="result-table-wrap">
          <table className="results-classes">
            <thead><tr><th>Class</th><th>Stage</th><th>Students</th><th>Action</th></tr></thead>
            <tbody>
              {data.classes.map((c) => (
                <tr key={c.classId}>
                  <td><strong>{c.displayName}</strong></td>
                  <td>
                    {c.stage === ''
                      ? <span className="muted">not compiled</span>
                      : <span className={`result-stage result-stage--${c.stage}`}>{c.stage === 'draft' ? 'Draft scores' : c.stage}</span>}
                  </td>
                  <td>
                    {c.stage !== '' || c.compiled > 0
                      // Single text node, so the SSR html reads exactly like the
                      // plugin's — no React comment markers inside the count.
                      ? `${c.compiled} compiled`
                      : c.enrolled > 0
                        ? <span className="muted">{`${c.enrolled} enrolled, none compiled`}</span>
                        : <span className="muted">no students enrolled</span>}
                  </td>
                  <td>
                    <ClassRow
                      scope={{ classId: c.classId, sessionId: Number(data.term!.sessionId), termId: Number(data.term!.id) }}
                      stage={c.stage}
                      principal={principal}
                      configured={Boolean(data.config)}
                      enrolled={c.enrolled}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="muted" style={{ marginTop: 12 }}>
          Compiling works out totals, grades and positions. Nothing reaches a student
          or parent until it has been signed off and then published.
        </p>
        {!data.config && (
          <p className="note">
            Academic settings are incomplete or invalid. Ask the principal to configure
            assessment components, a grading scale and a ranking policy. Compilation is
            unavailable until setup is complete.
          </p>
        )}
      </>}
    </section>
  </div>;
}
