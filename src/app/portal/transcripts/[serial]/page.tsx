import { notFound } from 'next/navigation';
import QRCode from 'qrcode';
import { requireSchoolSession } from '@/lib/session';
import { transcriptBySerial, verificationCode, verificationAvailable } from '@/lib/promotion/transcript';
import { ordinal } from '@/domain/academic';
import { PrintToolbar } from '../../reports/[studentId]/PrintToolbar';
import '../../../print.css';

export const dynamic = 'force-dynamic';

/** Legacy num(): integers print without decimals, everything else to 1 place. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * The issued academic transcript — a print document, not a dashboard.
 *
 * Legacy reference: TranscriptService::render(). Only PUBLISHED results are
 * transcribed; sessions run newest-first with terms in order; no behavioural
 * remarks anywhere (a candid termly comment must not follow a student into an
 * admissions office). The serial, issue status, verification code and QR seal
 * the document: it is an issued copy, and the print pipeline (browser print)
 * renders it the same way it renders the terminal report sheet.
 */
export default async function TranscriptDocument({
  params,
}: {
  params: Promise<{ serial: string }>;
}) {
  const { serial: raw } = await params;
  const actor = await requireSchoolSession();

  const data = await transcriptBySerial(actor, decodeURIComponent(raw)).catch(() => null);
  if (!data || !data.compiled.found || !data.compiled.student) notFound();

  const { transcript, compiled, school } = data;
  const student = compiled.student!;
  const hasCrest = Boolean(school?.logoUrl);
  const contact = [school?.phone, school?.email, school?.website].filter(Boolean).join(' · ');
  const code = verificationAvailable() ? verificationCode(transcript.serial) : null;
  const verifyPath = `/verify/transcript?serial=${encodeURIComponent(transcript.serial)}&code=${code ?? ''}`;
  const appUrl = process.env.APP_URL;
  const qr = code && appUrl ? await QRCode.toDataURL(`${appUrl}${verifyPath}`, { margin: 0, width: 240 }) : null;
  const issuedLabel = transcript.status === 'reissued' ? 'Reissue' : 'Issued';

  return (
    <>
      <PrintToolbar warn={transcript.status === 'revoked' ? 'This transcript is REVOKED — printed here for the record only.' : undefined} />

      <div className="doc">
        <div className="doc__sheet">
          {/* Crest watermark: a position:fixed layer so it repeats on EVERY
              printed page — the same fix the terminal report sheet needed. */}
          {hasCrest ? <div className="doc__wm" aria-hidden="true">{[0, 1, 2].map(n => <img key={n} src={school!.logoUrl!} alt="" />)}</div> : null}
          {!hasCrest && school?.name ? (
            <div className="doc__wm-fallback" aria-hidden="true"><span>{school.name}</span></div>
          ) : null}
          {/* Single-line OFFICIAL COPY watermark over the whole document. */}
          <div className="doc__wm-official" aria-hidden="true"><span>OFFICIAL COPY</span></div>

          <header className="doc__head">
            {hasCrest ? <img className="doc__crest" src={school!.logoUrl!} alt={`${school!.name} crest`} /> : null}
            <p className="doc__school">{school?.name ?? 'School'}</p>
            {school?.address ? <p className="doc__address">{school.address}</p> : null}
            {contact ? <p className="doc__contact">{contact}</p> : null}
          </header>

          <p className="doc__title">Academic Transcript</p>

          <table className="doc__bio">
            <tbody>
              <tr>
                <td className="label">Name</td><td><strong>{student.name}</strong></td>
                <td className="label">Admission No.</td><td>{student.admissionNumber}</td>
                <td rowSpan={3} style={{ width: '27mm', textAlign: 'center' }}>
                  {student.photoUrl ? <img className="doc__photo" src={student.photoUrl} alt="" /> : null}
                </td>
              </tr>
              <tr>
                <td className="label">Date of Birth</td>
                <td>{student.dateOfBirth ? student.dateOfBirth.toISOString().slice(0, 10) : '—'}</td>
                <td className="label">Sex</td>
                <td>{student.gender ? student.gender.charAt(0).toUpperCase() + student.gender.slice(1) : '—'}</td>
              </tr>
              <tr>
                <td className="label">Terms Recorded</td><td>{compiled.termsRecorded}</td>
                <td className="label">Status</td>
                <td>{student.status.charAt(0).toUpperCase() + student.status.slice(1)}{transcript.status === 'revoked' ? ' · REVOKED' : ''}</td>
              </tr>
            </tbody>
          </table>

          {compiled.sessions.map((session) => (
            <div className="doc__session" key={session.session}>
              <h2 style={{ fontSize: '11pt', margin: '5mm 0 2mm' }}>{session.session} &nbsp;·&nbsp; {session.className ?? '—'}</h2>
              {session.terms.map((term) => (
                <table className="doc__table" style={{ marginBottom: '3mm' }} key={term.term}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>{term.term} — Subject</th>
                      <th style={{ width: '18mm' }}>Score</th>
                      <th style={{ width: '18mm' }}>Grade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {term.subjects.map((subject) => (
                      <tr key={subject.code + subject.name}>
                        <td className="subject">{subject.name}</td>
                        <td>{num(subject.score)}</td>
                        <td>{subject.grade || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="subject">Term average {num(term.average)}% &nbsp;·&nbsp; Position {ordinal(term.position)} of {term.classSize || '—'}</td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              ))}
            </div>
          ))}

          <div className="doc__summary">
            <div className="doc__stat"><b>{compiled.termsRecorded}</b><span>Terms Recorded</span></div>
            <div className="doc__stat"><b>{num(compiled.cumulativeAverage)}%</b><span>Cumulative Average</span></div>
            <div className="doc__stat"><b>{compiled.sessions.length}</b><span>Sessions</span></div>
          </div>

          <p className="doc__key" style={{ marginTop: '6mm' }}>
            This transcript is a complete record of the internal academic results of the named
            student at {school?.name ?? 'this school'}. It is not a substitute for the West African
            Senior School Certificate (WASSCE) or NECO result, which reports a separate external
            examination.
          </p>

          {qr ? (
            <div className="doc__qr" style={{ pageBreakInside: 'avoid' }}>
              <img src={qr} alt="Scan to verify" width={80} height={80} />
              <span>Scan to verify authenticity</span>
            </div>
          ) : null}

          <div className="doc__serial">
            <span>Serial: <strong>{transcript.serial}</strong></span>
            {code ? <span>Verification code: <strong>{code}</strong></span> : null}
            <span>{issuedLabel}: {transcript.issuedAt.toISOString().slice(0, 10)}</span>
            {transcript.purpose ? <span>Purpose: {transcript.purpose}</span> : null}
            <span className="muted">Verify at /verify/transcript</span>
          </div>
        </div>
      </div>
    </>
  );
}
