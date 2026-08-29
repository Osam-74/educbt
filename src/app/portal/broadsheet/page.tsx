import { and, eq, asc, inArray } from 'drizzle-orm';
import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import '../../print.css';

export const dynamic = 'force-dynamic';

/**
 * The broadsheet: every student in a class against every subject.
 *
 * Landscape, because thirty students against fifteen subjects does not fit
 * across a portrait page. The @page rule for this lives in print.css so the
 * report cards printed from the same stylesheet stay portrait.
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

    if (!classId) return { classes, chosen: null, students: [], subjects: [], cells: new Map() };

    const [chosen] = classes.filter((c) => Number(c.id) === classId);

    const [term] = query.term
      ? await tx.select().from(schema.terms).where(eq(schema.terms.id, Number(query.term))).limit(1)
      : await tx.select().from(schema.terms)
          .where(and(eq(schema.terms.schoolId, actor.schoolId), eq(schema.terms.isCurrent, true)))
          .limit(1);

    const students = await tx
      .select({
        id: schema.students.id,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        admissionNumber: schema.students.admissionNumber,
      })
      .from(schema.enrollments)
      .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
      .where(and(
        eq(schema.enrollments.classId, classId),
        eq(schema.enrollments.status, 'active'),
      ))
      .orderBy(asc(schema.students.lastName), asc(schema.students.firstName));

    if (students.length === 0 || !term) {
      return { classes, chosen, students: [], subjects: [], cells: new Map(), term };
    }

    const rows = await tx
      .select({
        studentId: subjectResults.studentId,
        subjectId: subjectResults.subjectId,
        subjectName: schema.subjects.name,
        subjectCode: schema.subjects.code,
        total: subjectResults.total,
        grade: subjectResults.grade,
        complete: subjectResults.complete,
      })
      .from(subjectResults)
      .innerJoin(schema.subjects, eq(schema.subjects.id, subjectResults.subjectId))
      .where(and(
        eq(subjectResults.schoolId, actor.schoolId),
        eq(subjectResults.termId, Number(term.id)),
        inArray(subjectResults.studentId, students.map((s) => Number(s.id))),
      ));

    const subjectMap = new Map<number, { id: number; name: string; code: string }>();
    const cells = new Map<string, { total: number; grade: string; complete: boolean }>();

    for (const r of rows) {
      subjectMap.set(Number(r.subjectId), {
        id: Number(r.subjectId), name: r.subjectName, code: r.subjectCode,
      });

      cells.set(`${r.studentId}:${r.subjectId}`, {
        total: Number(r.total), grade: r.grade, complete: r.complete,
      });
    }

    const subjects = [...subjectMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    return { classes, chosen, students, subjects, cells, term };
  });

  const { classes, chosen, students, subjects, cells } = data;

  return (
    <>
      <div className="no-print" style={{ padding: '16px 20px' }}>
        <h1 className="page-title">Broadsheet</h1>
        <form method="get" className="filters">
          <select name="class" defaultValue={query.class ?? ''}>
            <option value="">Choose a class</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button type="submit">Show</button>
        </form>
        {students.length > 0 ? (
          <>
            <button type="button" className="print-trigger">Print / Save as PDF</button>
            <span className="muted" style={{ marginLeft: 10, fontSize: 13 }}>
              Prints landscape. Choose <strong>Landscape</strong> if your browser asks.
            </span>
            <script dangerouslySetInnerHTML={{ __html:
              `document.querySelector('.print-trigger').addEventListener('click',function(){window.print()})` }} />
          </>
        ) : null}
      </div>

      {students.length === 0 ? (
        <p className="muted no-print" style={{ padding: '0 20px' }}>
          {chosen ? 'No compiled results for that class yet.' : 'Choose a class.'}
        </p>
      ) : (
        <div className="doc doc--broadsheet">
          <div className="doc__sheet">
            <header className="doc__head">
              <p className="doc__school">Broadsheet</p>
              <p className="doc__title">
                {chosen?.name} — {data.term?.title ?? ''}
              </p>
            </header>

            <table className="doc__table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Student</th>
                  <th className="num">Adm. No.</th>
                  {subjects.map((s) => (
                    /* The CODE, not the full name. Fifteen full subject names
                       across a landscape page leaves no room for the marks. */
                    <th key={s.id} className="num" title={s.name}>{s.code}</th>
                  ))}
                  <th className="num">Total</th>
                  <th className="num">Avg</th>
                </tr>
              </thead>
              <tbody>
                {students.map((student, i) => {
                  const marks = subjects.map((s) => cells.get(`${student.id}:${s.id}`));
                  const counted = marks.filter((m) => m?.complete);
                  const total = counted.reduce((sum, m) => sum + (m?.total ?? 0), 0);
                  const avg = counted.length > 0 ? total / counted.length : 0;

                  return (
                    <tr key={student.id}>
                      <td className="num">{i + 1}</td>
                      <td>{student.lastName} {student.firstName}</td>
                      <td className="num">{student.admissionNumber}</td>
                      {marks.map((m, j) => (
                        <td key={j} className="num">
                          {m
                            ? (m.complete
                                ? m.total
                                : <span className="not-ranked">nr</span>)
                            : <span className="not-ranked">&ndash;</span>}
                        </td>
                      ))}
                      <td className="num"><strong>{total.toFixed(0)}</strong></td>
                      <td className="num">{counted.length > 0 ? avg.toFixed(1) : <span className="not-ranked">nr</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <p className="doc__grading-key">
              <strong>nr</strong> — not ranked: one or more assessment scores are missing,
              so the subject is excluded from the total and average.
              <strong> &ndash;</strong> — subject not offered by that student.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
