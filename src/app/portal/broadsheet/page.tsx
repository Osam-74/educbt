import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { ordinal, DEFAULT_RANKING, type RankingPolicy } from '@/domain/academic';
import { reportPositions, reportAverage } from '@/lib/reports/summary';
import { PrintTrigger } from './PrintTrigger';
import './BroadsheetControls.css';
import '../../print.css';

export const dynamic = 'force-dynamic';

/**
 * The broadsheet: students down, subjects across, totals and position on the
 * right. The document a results meeting actually works from.
 *
 * Ported from the plugin's templates/portal/exams/broadsheet.php: the screen
 * area is a single card (description, class picker, Download / Print), and
 * everything below is the printed document — school letterhead, the session
 * · term · class-size · class-average meta line, subject CODES across the
 * top with the grade in small text beside each mark, and an ordinal class
 * position on the right. A dash means the student does not offer the
 * subject — it is not a zero.
 */
export default async function BroadsheetPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string; term?: string }>;
}) {
  const query = await searchParams;
  const actor = await requireSchoolSession();

  requireRole(actor, SCHOOL_WIDE);

  const classId = Number(query.class ?? 0);

  const data = await forSchool(actor.schoolId, async (tx) => {
    const classes = await tx
      .select({ id: schema.classes.id, name: schema.classes.displayName })
      .from(schema.classes)
      .where(and(
        eq(schema.classes.schoolId, actor.schoolId),
        eq(schema.classes.status, 'active'),
      ))
      .orderBy(asc(schema.classes.displayName));

    const [school] = await tx
      .select({
        name: schema.schools.name,
        address: schema.schools.address,
        logoUrl: schema.schools.logoUrl,
      })
      .from(schema.schools)
      .where(eq(schema.schools.id, actor.schoolId));

    const [term] = query.term
      ? await tx.select().from(schema.terms).where(eq(schema.terms.id, Number(query.term))).limit(1)
      : await tx.select().from(schema.terms)
          .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.isCurrent, true)))
          .limit(1);

    const [session] = term
      ? await tx.select({ title: schema.academicSessions.title })
          .from(schema.academicSessions).where(eq(schema.academicSessions.id, term.sessionId)).limit(1)
      : [];

    // Default to the first class, exactly as the plugin does.
    const chosenId = classId || classes[0]?.id || 0;
    const chosen = classes.find((c) => Number(c.id) === chosenId);

    if (!chosenId || !term) {
      return {
        classes, school, session, term, chosen: chosen ?? null,
        students: [] as Array<{ id: number; admissionNumber: string; firstName: string; lastName: string }>,
        subjects: [] as Array<{ id: number; name: string; code: string }>,
        cells: new Map<string, { total: number; grade: string; complete: boolean }>(),
        rows: [] as Array<{ studentId: number; subjectId: number; total: string; examTotal: string; complete: boolean }>,
        registrations: [] as Array<{ studentId: number; subjectId: number }>,
        states: [] as string[],
        policy: undefined as RankingPolicy | undefined,
      };
    }

    const students = await tx
      .select({
        id: schema.students.id,
        admissionNumber: schema.students.admissionNumber,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
      })
      .from(schema.enrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(
        eq(schema.enrollments.classId, chosenId),
        eq(schema.enrollments.status, 'active'),
        eq(schema.enrollments.sessionId, Number(term.sessionId)),
      ))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    const ids = students.map((s) => Number(s.id));

    const resultRows = ids.length
      ? await tx
          .select({
            studentId: subjectResults.studentId,
            subjectId: subjectResults.subjectId,
            subjectName: schema.subjects.name,
            subjectCode: schema.subjects.code,
            total: subjectResults.total,
            examTotal: subjectResults.examTotal,
            grade: subjectResults.grade,
            complete: subjectResults.complete,
            state: subjectResults.state,
            rankingPolicy: subjectResults.rankingPolicy,
          })
          .from(subjectResults)
          .innerJoin(schema.subjects, eq(schema.subjects.id, subjectResults.subjectId))
          .where(and(
            eq(subjectResults.schoolId, actor.schoolId),
            eq(subjectResults.termId, Number(term.id)),
            eq(subjectResults.sessionId, Number(term.sessionId)),
            inArray(subjectResults.studentId, ids),
          ))
      : [];

    const registrations = ids.length
      ? await tx
          .select({ studentId: schema.studentSubjects.studentId, subjectId: schema.studentSubjects.subjectId })
          .from(schema.studentSubjects)
          .where(and(
            inArray(schema.studentSubjects.studentId, ids),
            eq(schema.studentSubjects.sessionId, Number(term.sessionId)),
          ))
      : [];

    const subjectMap = new Map<number, { id: number; name: string; code: string }>();
    const cells = new Map<string, { total: number; grade: string; complete: boolean }>();
    for (const r of resultRows) {
      subjectMap.set(Number(r.subjectId), {
        id: Number(r.subjectId), name: r.subjectName,
        code: r.subjectCode || r.subjectName,
      });
      cells.set(`${Number(r.studentId)}:${Number(r.subjectId)}`, {
        total: Number(r.total), grade: r.grade, complete: r.complete,
      });
    }
    // The plugin orders subjects by name (BroadsheetService::build).
    const subjects = [...subjectMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    return {
      classes, school, session, term, chosen,
      students, subjects, cells,
      rows: resultRows.map((r) => ({
        studentId: Number(r.studentId), subjectId: Number(r.subjectId),
        total: r.total, examTotal: r.examTotal, complete: r.complete,
      })),
      registrations,
      states: [...new Set(resultRows.map((r) => r.state))],
      policy: (resultRows.find((r) => r.rankingPolicy)?.rankingPolicy ?? undefined) as RankingPolicy | undefined,
    };
  });

  const { classes, school, session, term, chosen, students, subjects, cells, rows, registrations, states, policy } = data;
  const storedPolicy: RankingPolicy = policy ?? DEFAULT_RANKING;

  // Class position on per-student average — the same competition policy the
  // compilation used for subject positions, taken from the stored policy.
  const positions = reportPositions(
    students.map((s) => ({ studentId: Number(s.id), admissionNumber: s.admissionNumber })),
    rows, registrations, storedPolicy,
  );

  const perStudent = students.map((student) => {
    const marks = subjects.map((s) => cells.get(`${Number(student.id)}:${s.id}`));
    const counted = marks.filter((m) => m?.complete);
    const total = counted.reduce((sum, m) => sum + (m?.total ?? 0), 0);
    const average = counted.length > 0 ? total / counted.length : 0;
    return { student, marks, total, average, position: positions.get(Number(student.id)) ?? 0 };
  });
  const ranked = perStudent.filter((p) => p.marks.some((m) => m?.complete));
  const classAverage = reportAverage(ranked.map((p) => p.average));
  const stage = states.length > 1 ? 'mixed' : (states[0] ?? '');

  // "By subject" cohort stats — the plugin's BroadsheetService::stats()
  // per_subject block: entered count, average, spread and a 40-mark pass
  // rate for each subject offered in the class, so a results meeting can
  // see which subject is dragging the class down without opening every row.
  const perSubjectStats = subjects
    .map((subject) => {
      const totals = students
        .map((s) => cells.get(`${Number(s.id)}:${subject.id}`))
        .filter((c): c is { total: number; grade: string; complete: boolean } => !!c?.complete)
        .map((c) => c.total);
      if (totals.length === 0) return null;
      const entered = totals.length;
      const average = totals.reduce((sum, t) => sum + t, 0) / entered;
      const passRate = (totals.filter((t) => t >= 40).length / entered) * 100;
      return {
        subject, entered, average,
        highest: Math.max(...totals),
        lowest: Math.min(...totals),
        passRate,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  return (
    <>
      {/* Screen area: one card, exactly like the plugin's — description,
          class picker, Download / Print. Nothing else prints. */}
      <div className="no-print">
        <h1 className="page-title">Broadsheet</h1>
        <section className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            One sheet showing every student in the class down the side and every subject across
            the top, with totals and positions. It is the sheet a results meeting works from and
            what the class teacher signs before report sheets are printed.
          </p>
          <form method="get" className="broad-controls">
            <div className="broad-controls__field">
              <label htmlFor="cls">Class</label>
              <select id="cls" name="class" defaultValue={String(chosen?.id ?? '')}>
                {classes.length === 0 && <option value="">No classes yet</option>}
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <button type="submit" className="broad-controls__btn">Show</button>
            {students.length > 0 && <PrintTrigger />}
            {students.length > 0 && (
              <span className="muted" style={{ fontSize: '.78rem', maxWidth: 180 }}>
                Choose <strong>Save as PDF</strong>, and landscape, in the dialog.
              </span>
            )}
          </form>
        </section>

        {students.length === 0 && (
          <section className="card"><p className="muted">Nothing compiled for this class yet.</p></section>
        )}

        {/* Moderation status, so management knows what it can still do. */}
        {students.length > 0 && ['compiled', 'reviewed', 'published', 'locked', 'mixed'].includes(stage) && (
          <section className="card" style={{ marginBottom: 12 }}>
            <p className="note" style={{
              margin: 0,
              ...(stage === 'published' || stage === 'locked'
                ? { background: '#fef2f2', borderColor: '#b91c1c', color: '#7f1d1d' }
                : {}),
            }}>
              {stage === 'compiled' && <><strong>Status: Compiled</strong> — Results are compiled. You can moderate scores on the Review page and recompile as needed. Moderation will be locked once results are published to students.</>}
              {stage === 'reviewed' && <><strong>Status: Reviewed</strong> — Results are signed off but not yet published. Moderation is still possible. Once you publish, moderation will be locked.</>}
              {(stage === 'published' || stage === 'locked') && <><strong>Published.</strong> These results are now visible to students. Moderation is locked.</>}
              {stage === 'mixed' && <><strong>Mixed.</strong> Some rows are at a different stage — recompile the class to settle them.</>}
            </p>
          </section>
        )}
      </div>

      {students.length > 0 && chosen && (
        <div className="doc doc--broadsheet">
          <div className="doc__sheet">
            <header className="doc__head">
              {school?.logoUrl ? <img className="doc__crest" src={school.logoUrl} alt="" /> : null}
              <div>
                <p className="doc__school">{school?.name ?? ''}</p>
                <p className="doc__title">BROADSHEET</p>
                {school?.address ? <p className="doc__address">{school.address}</p> : null}
              </div>
            </header>

            <p className="muted doc__meta-line">
              {session?.title ?? ''} · {term?.title ?? ''} · {students.length} students · class average {classAverage}
            </p>

            <div className="doc__scroll">
              <table className="doc__table">
                <thead>
                  <tr>
                    <th>Student</th>
                    {subjects.map((s) => (
                      /* The CODE, not the full name — fifteen full subject names
                         across a landscape page leave no room for the marks. */
                      <th key={s.id} title={s.name}>{s.code}</th>
                    ))}
                    <th>Total</th>
                    <th>Avg</th>
                    <th>Pos</th>
                  </tr>
                </thead>
                <tbody>
                  {perStudent.map(({ student, marks, total, average, position }) => (
                    <tr key={student.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{student.lastName}, {student.firstName}</td>
                      {marks.map((m, j) => (
                        <td key={j}>
                          {m ? (
                            m.complete
                              ? <>{m.total} <span className="doc__cell-grade">{m.grade}</span></>
                              : <span className="not-ranked">nr</span>
                          ) : <span className="not-ranked">&ndash;</span>}
                        </td>
                      ))}
                      <td><strong>{total.toFixed(0)}</strong></td>
                      <td>{average.toFixed(1)}</td>
                      <td>{position > 0 ? ordinal(position) : <span className="not-ranked">nr</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="muted" style={{ marginTop: 10 }}>
              A dash means the student does not offer that subject — it is not a zero.
              <strong> nr</strong> — not ranked: one or more assessment scores are missing.
            </p>

            {perSubjectStats.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <h2 style={{ fontSize: 15, fontWeight: 660, margin: '0 0 10px' }}>By subject</h2>
                <div className="doc__scroll">
                  <table className="doc__table">
                    <thead>
                      <tr>
                        <th className="subject">Subject</th>
                        <th>Entered</th>
                        <th>Average</th>
                        <th>Highest</th>
                        <th>Lowest</th>
                        <th>Pass rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {perSubjectStats.map(({ subject, entered, average, highest, lowest, passRate }) => (
                        <tr key={subject.id}>
                          <td className="subject">{subject.name}</td>
                          <td>{entered}</td>
                          <td>{average.toFixed(2)}</td>
                          <td>{highest.toFixed(0)}</td>
                          <td>{lowest.toFixed(0)}</td>
                          <td>{passRate.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
