import { ordinal } from '@/domain/academic';
import { templateClass } from '@/lib/templates/registry';
import type { computeReportSheet } from '@/lib/reports/sheet-compute';

/** Legacy num(): integers print without decimals, everything else to 1 place. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * One terminal report sheet. The single report page and the whole-class print both draw exactly this, so a class set
 * is a stack of the same sheet the student sees. `breakBefore` starts the sheet on a new printed page (every sheet
 * after the first in a class print).
 */
export function ReportSheet({ sheet, breakBefore = false }: { sheet: ReturnType<typeof computeReportSheet>; breakBefore?: boolean }) {
  const { student, school, enrolment, term, results, cohort, rows, ranked, totalMarks, average, classPosition, density, hasCrest,
    contact, classTeacherName, gradingKey, signatures, extras, templateKey } = sheet;
  const data = { extras };
  const signature = (role: 'principal' | 'class_teacher') => {
    const saved = signatures[role];
    return saved ? saved.type === 'text'
      ? <span style={{ fontFamily: 'cursive', fontSize: '16pt' }}>{saved.data}</span>
      : <img src={saved.data} alt={role === 'principal' ? 'Principal signature' : 'Class teacher signature'} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}/> : null;
  };

  return (
      <div className={`doc ${templateClass(templateKey)}`.trim()} style={breakBefore ? { breakBefore: 'page', pageBreakBefore: 'always' } : undefined}>
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
            {data.extras?.attendance ? <div className="doc__stat"><b>{data.extras.attendance.present}/{data.extras.attendance.total}</b><span>Days Present</span></div> : null}
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
  );
}
