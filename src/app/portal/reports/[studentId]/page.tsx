import { notFound } from 'next/navigation';
import { and, eq, asc } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { isVisibleToFamily } from '@/domain/academic';
import '../../../print.css';

export const dynamic = 'force-dynamic';

export default async function ReportCard({
  params,
  searchParams,
}: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const { studentId: raw } = await params;
  const query = await searchParams;
  const actor = await requireSchoolSession();
  const studentId = Number(raw);

  const data = await forSchool(actor.schoolId, async (tx) => {
    const [student] = await tx
      .select({
        id: schema.students.id,
        firstName: schema.students.firstName,
        lastName: schema.students.lastName,
        admissionNumber: schema.students.admissionNumber,
        photoUrl: schema.students.photoUrl,
      })
      .from(schema.students)
      .where(and(
        eq(schema.students.id, studentId),
        eq(schema.students.schoolId, actor.schoolId),
      ))
      .limit(1);

    if (!student) return null;

    const [school] = await tx
      .select({
        name: schema.schools.name,
        address: schema.schools.address,
        logoUrl: schema.schools.logoUrl,
        principalName: schema.schools.principalName,
      })
      .from(schema.schools)
      .where(eq(schema.schools.id, actor.schoolId))
      .limit(1);

    const [enrolment] = await tx
      .select({
        className: schema.classes.displayName,
        sessionId: schema.academicSessions.id,
        sessionTitle: schema.academicSessions.title,
      })
      .from(schema.enrollments)
      .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
      .leftJoin(schema.academicSessions, eq(schema.academicSessions.id, schema.enrollments.sessionId))
      .where(and(
        eq(schema.enrollments.studentId, studentId),
        eq(schema.enrollments.status, 'active'),
      ))
      .limit(1);

    const termId = Number(query.term ?? 0);

    const [term] = termId
      ? await tx.select().from(schema.terms).where(eq(schema.terms.id, termId)).limit(1)
      : await tx.select().from(schema.terms)
          .where(and(
            eq(schema.terms.schoolId, actor.schoolId),
            eq(schema.terms.isCurrent, true),
          )).limit(1);

    const results = term
      ? await tx
          .select({
            subjectName: schema.subjects.name,
            caTotal: subjectResults.caTotal,
            examTotal: subjectResults.examTotal,
            total: subjectResults.total,
            grade: subjectResults.grade,
            remark: subjectResults.remark,
            position: subjectResults.subjectPosition,
            classSize: subjectResults.classSize,
            complete: subjectResults.complete,
            state: subjectResults.state,
            scaleId: subjectResults.gradingScaleId,
            scaleVersion: subjectResults.gradingScaleVersion,
          })
          .from(subjectResults)
          .innerJoin(schema.subjects, eq(schema.subjects.id, subjectResults.subjectId))
          .where(and(
            eq(subjectResults.studentId, studentId),
            eq(subjectResults.termId, Number(term.id)),
          ))
          .orderBy(asc(schema.subjects.name))
      : [];

    return { student, school, enrolment, term, results };
  });

  if (!data) notFound();

  const { student, school, enrolment, term, results } = data;

  const ranked = results.filter((r) => r.complete);
  const totalMarks = ranked.reduce((s, r) => s + Number(r.total), 0);
  const average = ranked.length > 0 ? totalMarks / ranked.length : 0;

  // Staff may read a compiled result before it is published; a family may not.
  const anyUnpublished = results.some((r) => !isVisibleToFamily(r.state));

  return (
    <>
      <div className="no-print" style={{ padding: '16px 20px', background: '#fff', borderBottom: '1px solid #d8dcd4' }}>
        <button type="button" onClick={undefined} className="print-trigger">Print / Save as PDF</button>
        {anyUnpublished ? (
          <span className="note" style={{ marginLeft: 12, display: 'inline-block' }}>
            Not yet published — visible to staff only.
          </span>
        ) : null}
        {/* Printing is the browser's own engine. See print.css for why. */}
        <script dangerouslySetInnerHTML={{ __html:
          `document.querySelector('.print-trigger').addEventListener('click',function(){window.print()})` }} />
      </div>

      <div className="doc">
        <div className="doc__sheet">
          <header className="doc__head">
            {school?.logoUrl ? <img className="doc__crest" src={school.logoUrl} alt="" /> : null}
            <p className="doc__school">{school?.name ?? 'School'}</p>
            {school?.address ? <p className="doc__address">{school.address}</p> : null}
            <p className="doc__title">Terminal Report Sheet</p>
          </header>

          <table className="doc__bio">
            <tbody>
              <tr>
                <td className="label">Name:</td>
                <td><strong>{student.firstName} {student.lastName}</strong></td>
                <td className="label">Admission No.:</td>
                <td>{student.admissionNumber}</td>
              </tr>
              <tr>
                <td className="label">Class:</td>
                <td>{enrolment?.className ?? '—'}</td>
                <td className="label">Session:</td>
                <td>{enrolment?.sessionTitle ?? '—'}</td>
              </tr>
              <tr>
                <td className="label">Term:</td>
                <td>{term?.title ?? '—'}</td>
                <td className="label">Subjects:</td>
                <td>{results.length}</td>
              </tr>
            </tbody>
          </table>

          <table className="doc__table">
            <thead>
              <tr>
                <th>Subject</th>
                <th className="num">CA</th>
                <th className="num">Exam</th>
                <th className="num">Total</th>
                <th className="grade">Grade</th>
                <th className="num">Pos.</th>
                <th>Remark</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.subjectName}>
                  <td>{r.subjectName}</td>
                  <td className="num">{Number(r.caTotal)}</td>
                  <td className="num">{Number(r.examTotal)}</td>
                  <td className="num"><strong>{Number(r.total)}</strong></td>
                  <td className="grade">{r.grade}</td>
                  <td className="num">
                    {/* NOT RANKED is stated. A zero would read as last place and
                        a blank cell as an oversight. */}
                    {r.complete && r.position > 0
                      ? `${r.position}/${r.classSize}`
                      : <span className="not-ranked">not ranked</span>}
                  </td>
                  <td>{r.remark}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {results.some((r) => !r.complete) ? (
            <p className="not-ranked" style={{ marginTop: '3mm' }}>
              Subjects marked <em>not ranked</em> are missing one or more assessment
              scores and have been excluded from position and average.
            </p>
          ) : null}

          <div className="doc__summary">
            <div className="doc__stat"><b>{ranked.length}</b><span>Subjects ranked</span></div>
            <div className="doc__stat"><b>{totalMarks.toFixed(0)}</b><span>Total</span></div>
            <div className="doc__stat"><b>{average.toFixed(1)}%</b><span>Average</span></div>
          </div>

          <div className="doc__remarks">
            <p><strong>Class Teacher:</strong> <span className="line" /></p>
            <p><strong>Principal:</strong> <span className="line" /></p>
          </div>

          <div className="doc__signs">
            <div className="doc__sign">
              <div className="rule" />
              <div className="name">Class Teacher</div>
              <div className="role">Signature &amp; Date</div>
            </div>
            <div className="doc__sign">
              <div className="rule" />
              <div className="name">{school?.principalName ?? 'Principal'}</div>
              <div className="role">Principal</div>
            </div>
          </div>

          <p className="doc__grading-key">
            <strong>Grading:</strong> A1 75–100 Excellent · B2 70–74 Very Good · B3 65–69 Good ·
            C4 60–64 · C5 55–59 · C6 50–54 Credit · D7 45–49 · E8 40–44 Pass · F9 0–39 Fail.
            {results[0]?.scaleId ? (
              <> Scale <em>{results[0].scaleId}</em> v{results[0].scaleVersion}, as applied when
              these results were compiled.</>
            ) : null}
          </p>
        </div>
      </div>
    </>
  );
}
