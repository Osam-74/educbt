import { notFound } from 'next/navigation';
import { and, eq, asc, inArray } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { subjectResults } from '@/db/schema/results';
import { isVisibleToFamily, ordinal, DEFAULT_RANKING,
  type RankingPolicy } from '@/domain/academic';
import { reportAudience } from '@/lib/results/report-access';
import { reportPositions, reportAverage, reportGradingKey } from '@/lib/reports/summary';
import { PrintToolbar } from './PrintToolbar';
import { reportExtras } from '@/lib/settings/remarks';
import { RemarkEditor } from './RemarkEditor';
import '../../../print.css';

export const dynamic = 'force-dynamic';

/** Legacy num(): integers print without decimals, everything else to 1 place. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Legacy density system: a report sheet is ONE page, and everything on it is
 * sized relative to how many subjects the student offers. Above the overflow
 * threshold nothing is compacted further — squeezing a 20-subject sheet onto
 * one page would produce type nobody can read, so it is allowed a second page.
 * Thresholds and trims: see DocumentBrandingService.php, re-measured for this
 * stylesheet in scripts/test-print.py.
 */
function densityClass(subjectCount: number): string {
  if (subjectCount <= 9) return 'fit-roomy';
  if (subjectCount <= 11) return 'fit-snug';
  if (subjectCount <= 14) return 'fit-tight';
  return 'fit-overflow';
}

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
        phone: schema.schools.phone,
        email: schema.schools.email,
        website: schema.schools.website,
        logoUrl: schema.schools.logoUrl,
        principalName: schema.schools.principalName,
      })
      .from(schema.schools)
      .where(eq(schema.schools.id, actor.schoolId))
      .limit(1);

    // Resolve the term FIRST: a chosen term id, else the school's current
    // term. Everything below hangs off term.sessionId, so one resolution
    // beats repeating the choice.
    const termId = Number(query.term ?? 0);
    const [term] = await tx
      .select()
      .from(schema.terms)
      .where(and(
        eq(schema.terms.schoolId, actor.schoolId),
        termId ? eq(schema.terms.id, termId) : eq(schema.terms.isCurrent, true),
      ))
      .limit(1);

    const [enrolment] = term
      ? await tx
          .select({
            classId: schema.enrollments.classId,
            className: schema.classes.displayName,
            sessionId: schema.academicSessions.id,
            sessionTitle: schema.academicSessions.title,
          })
          .from(schema.enrollments)
          .leftJoin(schema.classes, eq(schema.classes.id, schema.enrollments.classId))
          .leftJoin(schema.academicSessions, eq(schema.academicSessions.id, schema.enrollments.sessionId))
          .where(and(
            eq(schema.enrollments.studentId, studentId),
            eq(schema.enrollments.sessionId, Number(term.sessionId)),
            eq(schema.enrollments.status, 'active'),
          ))
          .limit(1)
      : [];

    const results = term
      ? await tx
          .select({
            subjectId: subjectResults.subjectId,
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
            published: subjectResults.published,
            scaleId: subjectResults.gradingScaleId,
            scaleVersion: subjectResults.gradingScaleVersion,
            rankingPolicy: subjectResults.rankingPolicy,
          })
          .from(subjectResults)
          .innerJoin(schema.subjects, eq(schema.subjects.id, subjectResults.subjectId))
          .where(and(
            eq(subjectResults.studentId, studentId),
            eq(subjectResults.termId, Number(term.id)),
            eq(subjectResults.sessionId, Number(term.sessionId)),
          ))
          .orderBy(asc(schema.subjects.name))
      : [];

    const audience = await reportAudience(tx, actor, studentId, Number(term?.sessionId ?? 0));
    if (!audience) return null;
    if (audience !== 'staff' && (!results.length || results.some(r => audience === 'family'
      ? !isVisibleToFamily(r.state) || !r.published
      : !['reviewed', 'published', 'locked'].includes(r.state)))) return null;

    // Subject registration is AUTHORITATIVE for what a student sits. A
    // registered subject with no compiled scores still belongs on the sheet —
    // stated with em-dashes, never silently dropped (legacy behaviour).
    const registered = term
      ? await tx
          .select({
            subjectId: schema.studentSubjects.subjectId,
            subjectName: schema.subjects.name,
          })
          .from(schema.studentSubjects)
          .innerJoin(schema.subjects, eq(schema.subjects.id, schema.studentSubjects.subjectId))
          .where(and(
            eq(schema.studentSubjects.studentId, studentId),
            eq(schema.studentSubjects.sessionId, Number(term.sessionId)),
            eq(schema.subjects.status, 'active'),
          ))
          .orderBy(asc(schema.subjects.name))
      : [];

    // ── Class cohort: "No. in Class", per-subject Class Avg / Highest, and
    // Position in Class are all derived from the SAME stored results the
    // lifecycle compiled — read-only aggregation, no values invented. The
    // legacy stored these in a term_results summary at compile time; until
    // that table exists, deriving them from subject_results keeps the sheet
    // honest (and consistent with how subject positions were stored).
    const cohort = enrolment?.classId && term
      ? await tx
          .select({ studentId: schema.enrollments.studentId, admissionNumber: schema.students.admissionNumber })
          .from(schema.enrollments)
          .innerJoin(schema.students, eq(schema.students.id, schema.enrollments.studentId))
          .where(and(
            eq(schema.enrollments.classId, enrolment.classId),
            eq(schema.enrollments.sessionId, Number(term.sessionId)),
            eq(schema.enrollments.status, 'active'),
            eq(schema.students.status, 'active'),
          ))
      : [];

    const cohortIds = cohort.map((c) => c.studentId);
    const cohortRows = cohortIds.length && term
      ? await tx
          .select({
            studentId: subjectResults.studentId,
            subjectId: subjectResults.subjectId,
            total: subjectResults.total,
            examTotal: subjectResults.examTotal,
            complete: subjectResults.complete,
          })
          .from(subjectResults)
          .where(and(
            inArray(subjectResults.studentId, cohortIds),
            eq(subjectResults.sessionId, Number(term.sessionId)),
            eq(subjectResults.termId, Number(term.id)),
          ))
      : [];

    const cohortRegistrations = cohortIds.length && term ? await tx.select({ studentId: schema.studentSubjects.studentId, subjectId: schema.studentSubjects.subjectId })
      .from(schema.studentSubjects).where(and(inArray(schema.studentSubjects.studentId, cohortIds), eq(schema.studentSubjects.sessionId, Number(term.sessionId)))) : [];

    // The class teacher whose name belongs on the sheet — the staff member
    // actually holding this class, not "any teacher".
    const [classTeacher] = enrolment?.classId
      ? await tx
          .select({ id: schema.staff.id, firstName: schema.staff.firstName, lastName: schema.staff.lastName })
          .from(schema.staffAssignments)
          .innerJoin(schema.staff, eq(schema.staff.id, schema.staffAssignments.staffId))
          .where(and(
            eq(schema.staffAssignments.classId, enrolment.classId),
            eq(schema.staffAssignments.assignmentType, 'class_teacher'),
            eq(schema.staffAssignments.status, 'active'),
            eq(schema.staff.status, 'active'),
          ))
          .limit(1)
      : [];

    const extras = term && enrolment?.classId ? await reportExtras(tx, studentId, Number(term.sessionId), Number(term.id), enrolment.classId) : null;
    const scaleSnapshots = await tx.select({ snapshot: schema.gradingScaleVersions.snapshot }).from(schema.gradingScaleVersions);
    return { student, school, enrolment, term, results, registered, cohort, cohortRows, cohortRegistrations, extras, scaleSnapshots,
      classTeacher: classTeacher ?? null };
  });

  if (!data) notFound();

  const { student, school, enrolment, term, results, registered, cohort, cohortRows, cohortRegistrations, classTeacher } = data;

  // ── Cohort statistics, computed once ──────────────────────────────────────
  const perSubject = new Map<number, { totals: number[]; examTotals: number[] }>();

  for (const row of cohortRows) {
    if (!row.complete) continue;
    const total = Number(row.total);
    const exam = Number(row.examTotal);
    const subject = perSubject.get(row.subjectId) ?? { totals: [], examTotals: [] };
    subject.totals.push(total);
    subject.examTotals.push(exam);
    perSubject.set(row.subjectId, subject);

  }

  const classStats = new Map(Array.from(perSubject.entries()).map(([subjectId, s]) => [subjectId, {
    average: s.totals.reduce((a, b) => a + b, 0) / s.totals.length,
    highest: Math.max(...s.totals),
  }]));

  // Position in Class: rank the cohort on per-student average — the same
  // competition policy the compilation used for subject positions, taken from
  // the stored ranking policy when one exists.
  const storedPolicy = results.find(r => r.rankingPolicy)?.rankingPolicy as RankingPolicy | undefined;
  const policy = storedPolicy?.tiePolicy ? storedPolicy : DEFAULT_RANKING;
  const positions = reportPositions(cohort, cohortRows, cohortRegistrations, policy);
  const classPosition = positions.get(studentId) ?? 0;

  // ── Marks rows: registration is the spine; compiled scores join onto it ──
  const bySubject = new Map(results.map(r => [r.subjectId, r]));
  const rows: Array<{
    subjectName: string;
    result: typeof results[number] | null;
    classAverage: number | null;
    highest: number | null;
  }> = [];
  for (const reg of registered) {
    const result = bySubject.get(reg.subjectId) ?? null;
    const stats = classStats.get(reg.subjectId);
    rows.push({
      subjectName: reg.subjectName,
      result,
      classAverage: stats?.average ?? null,
      highest: stats?.highest ?? null,
    });
    if (result) bySubject.delete(reg.subjectId);
  }
  // Compiled scores for subjects no longer registered are still real marks —
  // keep them on the sheet rather than hiding them.
  for (const [, result] of bySubject) {
    rows.push({
      subjectName: result.subjectName,
      result,
      classAverage: classStats.get(result.subjectId)?.average ?? null,
      highest: classStats.get(result.subjectId)?.highest ?? null,
    });
  }

  const ranked = results.filter((r) => r.complete);
  const totalMarks = ranked.reduce((s, r) => s + Number(r.total), 0);
  const average = reportAverage(ranked.map(r => Number(r.total)));

  // Staff may read a compiled result before it is published; a family may not.
  const anyUnpublished = results.some((r) => !isVisibleToFamily(r.state));

  const density = densityClass(rows.length);
  const hasCrest = Boolean(school?.logoUrl);
  const contact = [school?.phone, school?.email].filter(Boolean).join('  •  ');
  const classTeacherName = classTeacher
    ? `${classTeacher.firstName} ${classTeacher.lastName}` : '';

  const gradingKey = reportGradingKey(results, data.scaleSnapshots.map(s => s.snapshot));
  const editableRemarks = results.length > 0 && results.every(r => ['draft', 'compiled'].includes(r.state) && !r.published);
  const signature = (role: 'principal' | 'class_teacher') => {
    const saved = data.extras?.signatures[role];
    return saved ? saved.type === 'text'
      ? <span style={{ fontFamily: 'cursive', fontSize: '16pt' }}>{saved.data}</span>
      : <img src={saved.data} alt={role === 'principal' ? 'Principal signature' : 'Class teacher signature'} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}/> : null;
  };

  return (
    <>
      <PrintToolbar warn={anyUnpublished ? 'Not yet published — visible to staff only.' : undefined} />
      {editableRemarks && term && actor.role === 'principal' && actor.staffId && <RemarkEditor studentId={studentId} sessionId={Number(term.sessionId)} termId={Number(term.id)} role="principal" initial={data.extras?.remarks.principal ?? ''}/>}
      {editableRemarks && term && classTeacher?.id === actor.staffId && <RemarkEditor studentId={studentId} sessionId={Number(term.sessionId)} termId={Number(term.id)} role="class_teacher" initial={data.extras?.remarks.class_teacher ?? ''}/>}

      <div className="doc">
        <div
          className={`doc__sheet ${density}`}
        >
          {/* Crest watermark: a position:fixed layer so it repeats on EVERY
              printed page (a sheet background or a positioned veil is painted
              once and clipped at the first page fragment — see print.css). */}
          {hasCrest ? <div className="doc__wm" aria-hidden="true">{[0, 1, 2].map(n => <img key={n} src={school!.logoUrl!} alt="" />)}</div> : null}

          {/* No crest: the school name as a slanted text watermark, so the
              sheet is never printed with no watermark at all. */}
          {!hasCrest && school?.name ? (
            <div className="doc__wm-fallback" aria-hidden="true"><span>{school.name}</span></div>
          ) : null}

          <header className="doc__head">
            {hasCrest ? <img className="doc__crest" src={school!.logoUrl!} alt={`${school!.name} crest`} /> : null}
            <p className="doc__school">{school?.name ?? 'School'}</p>
            {school?.address ? <p className="doc__address">{school.address}</p> : null}
            {contact ? <p className="doc__contact">{contact}</p> : null}
          </header>

          <p className="doc__title">Terminal Report Sheet</p>

          <table className="doc__bio">
            <tbody>
              <tr>
                {student.photoUrl ? (
                  <td rowSpan={3} className="doc__photo-cell">
                    <img className="doc__photo" src={student.photoUrl} alt="" />
                  </td>
                ) : null}
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
                <td className="label">No. in Class:</td>
                <td>{cohort.length}</td>
              </tr>
            </tbody>
          </table>

          <table className="doc__table">
            <colgroup>
              <col className="c-subject" /><col className="c-ca" /><col className="c-exam" />
              <col className="c-total" /><col className="c-grade" /><col className="c-pos" />
              <col className="c-avg" /><col className="c-high" /><col className="c-remark" />
            </colgroup>
            <thead>
              <tr>
                {/* Only Subject is left-aligned; every other heading —
                    including Remark — is centred like the legacy sheet. */}
                <th className="subject">Subject</th>
                <th>CA</th>
                <th>Exam</th>
                <th>Total</th>
                <th className="grade">Grade</th>
                <th>Pos.</th>
                <th>Class Avg</th>
                <th>Highest</th>
                <th>Remark</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                if (!row.result || !row.result.complete) {
                  if (!row.result) {
                    // Registered, never scored — stated absence, legacy style.
                    return (
                      <tr key={`dash-${row.subjectName}`}>
                        <td className="subject">{row.subjectName}</td>
                        <td className="dash">—</td><td className="dash">—</td><td className="dash">—</td>
                        <td className="dash">—</td><td className="dash">—</td><td className="dash">—</td>
                        <td className="dash">—</td><td className="dash">—</td>
                      </tr>
                    );
                  }
                  // Compiled but incomplete: the stored numbers are real and
                  // belong on the sheet; position is a stated absence.
                  const r = row.result;
                  return (
                    <tr key={`inc-${row.subjectName}`}>
                      <td className="subject">{row.subjectName}</td>
                      <td className="num">{num(Number(r.caTotal))}</td>
                      <td className="num">{num(Number(r.examTotal))}</td>
                      <td className="num"><strong>{num(Number(r.total))}</strong></td>
                      <td className="grade">{r.grade || '—'}</td>
                      <td className="num"><span className="not-ranked">not ranked</span></td>
                      <td className="num">{row.classAverage !== null ? num(row.classAverage) : '—'}</td>
                      <td className="num">{row.highest !== null ? num(row.highest) : '—'}</td>
                      <td>{r.remark || '—'}</td>
                    </tr>
                  );
                }
                const r = row.result;
                return (
                  <tr key={`ok-${row.subjectName}`}>
                    <td className="subject">{row.subjectName}</td>
                    <td className="num">{num(Number(r.caTotal))}</td>
                    <td className="num">{num(Number(r.examTotal))}</td>
                    <td className="num"><strong>{num(Number(r.total))}</strong></td>
                    <td className="grade">{r.grade || '—'}</td>
                    <td className="num">{ordinal(r.position)}</td>
                    <td className="num">{row.classAverage !== null ? num(row.classAverage) : '—'}</td>
                    <td className="num">{row.highest !== null ? num(row.highest) : '—'}</td>
                    <td>{r.remark || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {results.some((r) => !r.complete) ? (
            <p className="not-ranked" style={{ marginTop: '3mm' }}>
              Subjects marked <em>not ranked</em> are missing one or more assessment
              scores and have been excluded from position and average.
            </p>
          ) : null}

          <div className="doc__summary">
            <div className="doc__stat"><b>{ranked.length}</b><span>Subjects</span></div>
            <div className="doc__stat"><b>{num(totalMarks)}</b><span>Total Score</span></div>
            <div className="doc__stat"><b>{average}</b><span>Average</span></div>
            <div className="doc__stat"><b>{ordinal(classPosition)}</b><span>Position in Class</span></div>
          </div>

          <div className="doc__remarks">
            <p><strong>Class Teacher&rsquo;s Remark:</strong> <span className="doc__remark-text">{data.extras?.remarks.class_teacher || '—'}</span></p>
            <p><strong>Principal&rsquo;s Remark:</strong> <span className="doc__remark-text">{data.extras?.remarks.principal || '—'}</span></p>
          </div>

          <div className="doc__sign">
            <div className="doc__sign-box">
              <div className="doc__sig-area">{signature('class_teacher')}</div>
              <div className="doc__sig-line">{classTeacherName || '____________________'}</div>
              <div className="doc__sig-role">Class Teacher</div>
            </div>
            <div className="doc__sign-box">
              <div className="doc__sig-area">{signature('principal')}</div>
              <div className="doc__sig-line">{school?.principalName || '____________________'}</div>
              <div className="doc__sig-role">Principal</div>
            </div>
          </div>

          <p className="doc__key">
            <strong>Grading Key:</strong> {gradingKey}.
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
