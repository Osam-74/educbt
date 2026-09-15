import { redirect } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import {
  canIssueTranscript, issueTranscript,
  searchTranscriptStudents, issuedTranscriptOverview,
} from '@/lib/promotion/transcript';

export const dynamic = 'force-dynamic';

/**
 * Transcript office (legacy EduCBT Pro parity: templates/portal/school/transcripts.php).
 * The plugin's two cards: "Issue a transcript" — search by NAME or admission
 * number, with an Issue/Reissue button on every match — and the "Issued"
 * register grouped by student: one row per student with the issue count and
 * the latest serial. The printed document itself lives at /portal/transcripts/[serial].
 */
export default async function TranscriptsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  if (!canIssueTranscript(actor)) redirect('/portal');
  const query = await searchParams;

  const search = (query.q ?? '').trim();
  const found = search ? await searchTranscriptStudents(actor, search).catch(() => null) : null;
  const issued = await issuedTranscriptOverview(actor).catch(() => []);

  async function issue(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/transcripts?q=${encodeURIComponent(String(formData.get('q') ?? ''))}`;
    let destination: string;
    try {
      const result = await issueTranscript(inner, Number(formData.get('studentId')), String(formData.get('purpose') ?? ''));
      destination = `${back}&ok=${encodeURIComponent(
        `Transcript ${result.serial} recorded. Open it from the register below to print.`)}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not issue that transcript.')}`;
    }
    redirect(destination);
  }

  return (
    <>
      <h1 className="page-title">Transcripts</h1>

      {query.error ? <p className="alert" role="alert">{query.error}</p> : null}
      {query.ok ? <p className="ok" role="status">{query.ok}</p> : null}

      <section className="card">
        <h2 className="sub-head">Issue a transcript</h2>
        <form method="get" className="search-row">
          <label htmlFor="q" style={{ flex: 1 }}>Find a student
            <input id="q" name="q" type="text" defaultValue={search} placeholder="Name or admission number" />
          </label>
          <button type="submit">Search</button>
        </form>

        {search !== '' ? (found === null || found.length === 0 ? <p className="muted">No student matched.</p> : (
          <table className="tbl">
            <thead><tr><th>Adm. no.</th><th>Student</th><th>Status</th><th>Issued</th><th></th></tr></thead>
            <tbody>
              {found.map(s => {
                const previouslyIssued = s.issuedCount > 0;
                return <tr key={s.id}>
                  <td><code>{s.admissionNumber}</code></td>
                  <td>{s.firstName} {s.lastName}</td>
                  <td style={{ textTransform: 'capitalize' }}>{s.status}</td>
                  <td>
                    {previouslyIssued ? (<>
                      <span className="pill">{s.issuedCount} time{s.issuedCount > 1 ? 's' : ''}</span>
                      <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Latest: {s.latestSerial}</div>
                    </>) : <span className="muted">Not issued</span>}
                  </td>
                  <td>
                    <form action={issue} style={{ display: 'flex', gap: 8 }}>
                      <input type="hidden" name="studentId" value={s.id} />
                      <input type="hidden" name="q" value={search} />
                      <label className="sr-only" htmlFor={'purpose-' + s.id}>Purpose</label>
                      <input id={'purpose-' + s.id} name="purpose" type="text" placeholder="Purpose, e.g. transfer" maxLength={255} />
                      <button type="submit" className="primary">{previouslyIssued ? 'Reissue' : 'Issue'}</button>
                    </form>
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        )) : null}
      </section>

      <section className="card">
        <h2 className="sub-head">Issued</h2>
        {issued.length === 0 ? <p className="muted">None yet.</p> : (
          <>
            <table className="tbl">
              <thead><tr><th>Adm. no.</th><th>Student</th><th>Serial</th><th>Purpose</th><th>Times issued</th><th>Last issued</th><th>Status</th></tr></thead>
              <tbody>
                {issued.map(t => <tr key={t.studentId}>
                  <td><code>{t.admissionNumber}</code></td>
                  <td>{t.name}</td>
                  <td><a href={`/portal/transcripts/${encodeURIComponent(t.latestSerial)}`}><code>{t.latestSerial}</code></a></td>
                  <td>{t.latestPurpose || '—'}</td>
                  <td><span className="pill">{t.issuedCount}</span></td>
                  <td>{t.lastIssuedAt.toISOString().slice(0, 10)}</td>
                  <td><span className="pill pill--published">Issued</span></td>
                </tr>)}
              </tbody>
            </table>
            <p className="muted">One row per student. The serial shown is the latest issue. All copies are recorded for traceability.</p>
          </>
        )}
      </section>
    </>
  );
}
