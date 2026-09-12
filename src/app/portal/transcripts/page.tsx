import { redirect } from 'next/navigation';
import { and, eq, desc } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { canIssueTranscript, issueTranscript, revokeTranscript, transcriptHistory, transcriptData } from '@/lib/promotion/transcript';

export const dynamic = 'force-dynamic';

/**
 * Transcript office (legacy EduCBT Pro parity: templates/portal/transcript.php).
 * Principal only — the transcript is a sealed, serialised document that speaks
 * for the school to the outside world. Issuance is recorded BEFORE anything is
 * rendered, every copy is logged, and any copy can be revoked with a reason.
 */
export default async function TranscriptsPage({
  searchParams,
}: {
  searchParams: Promise<{ student?: string; error?: string; ok?: string }>;
}) {
  const actor = await requireSchoolSession();
  if (!canIssueTranscript(actor)) redirect('/portal');
  const query = await searchParams;

  const admission = (query.student ?? '').trim();
  const loaded = admission
    ? await forSchool(actor.schoolId, async (tx) => {
        const [student] = await tx.select({
          id: schema.students.id, firstName: schema.students.firstName, lastName: schema.students.lastName,
          admissionNumber: schema.students.admissionNumber, status: schema.students.status,
        }).from(schema.students)
          .where(and(eq(schema.students.admissionNumber, admission), eq(schema.students.schoolId, actor.schoolId)));
        return student ?? null;
      })
    : null;

  const data = loaded ? await transcriptData(actor, loaded.id) : null;
  const history = loaded ? await transcriptHistory(actor, loaded.id).then(h => h.transcripts).catch(() => null) : null;

  async function issue(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const studentId = Number(formData.get('studentId'));
    const back = `/portal/transcripts?student=${encodeURIComponent(String(formData.get('admission') ?? ''))}`;
    let destination: string;
    try {
      const result = await issueTranscript(inner, studentId, String(formData.get('purpose') ?? ''));
      destination = `${back}&ok=${encodeURIComponent(`Transcript ${result.serial} recorded (${result.status}). Open it from the history below to print.`)}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not issue that transcript.')}`;
    }
    redirect(destination);
  }

  async function revoke(formData: FormData) {
    'use server';
    const inner = await requireSchoolSession();
    const back = `/portal/transcripts?student=${encodeURIComponent(String(formData.get('admission') ?? ''))}`;
    let destination: string;
    try {
      await revokeTranscript(inner, String(formData.get('serial') ?? ''), String(formData.get('reason') ?? ''));
      destination = `${back}&ok=${encodeURIComponent('Transcript revoked. Later verifications will say so.')}`;
    } catch (error) {
      destination = `${back}&error=${encodeURIComponent(error instanceof Error ? error.message : 'Could not revoke that transcript.')}`;
    }
    redirect(destination);
  }

  return (
    <>
      <h1 className="page-title">Transcripts</h1>

      {query.error ? <p className="alert" role="alert">{query.error}</p> : null}
      {query.ok ? <p className="ok" role="status">{query.ok}</p> : null}

      <form method="get" action="/portal/transcripts" style={{ margin: '16px 0' }}>
        <label htmlFor="student">Admission number</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="student" name="student" defaultValue={admission} placeholder="e.g. GRE/2024/0001" style={{ maxWidth: 320 }} required />
          <button type="submit">Load student</button>
        </div>
      </form>

      {admission && !loaded ? <p className="alert">No student with that admission number is in this school.</p> : null}

      {loaded && data ? (
        <>
          <section>
            <h2 className="sub-head">{loaded.firstName} {loaded.lastName} <span className="muted">· {loaded.admissionNumber} · {loaded.status}</span></h2>
            {data.found ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, margin: '12px 0' }}>
                <div className="stat"><b style={{ fontSize: 22 }}>{data.sessions.length}</b><span className="muted">Sessions</span></div>
                <div className="stat"><b style={{ fontSize: 22 }}>{data.termsRecorded}</b><span className="muted">Terms recorded</span></div>
                <div className="stat"><b style={{ fontSize: 22 }}>{data.cumulativeAverage}%</b><span className="muted">Cumulative average</span></div>
              </div>
            ) : (
              <p className="muted">No published results on record — there is nothing to transcribe yet.</p>
            )}

            {data.found ? (
              <form action={issue} style={{ margin: '12px 0' }}>
                <input type="hidden" name="studentId" value={loaded.id} />
                <input type="hidden" name="admission" value={loaded.admissionNumber} />
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input name="purpose" placeholder="Purpose (e.g. university admission)" style={{ flex: 1, minWidth: 240 }} maxLength={255} />
                  <button type="submit">Issue transcript</button>
                </div>
              </form>
            ) : null}
          </section>

          <section>
            <h2 className="sub-head">Issued copies</h2>
            {history === null || history.length === 0 ? (
              <p className="muted">No transcript has been issued for this student yet.</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr><th>Serial</th><th>Purpose</th><th>Issued</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.id}>
                      <td><strong>{row.serial}</strong></td>
                      <td>{row.purpose || '—'}</td>
                      <td>{row.issuedAt.toISOString().slice(0, 10)}</td>
                      <td><strong>{row.status}</strong>{row.status === 'revoked' ? <span className="muted"> on {row.revokedAt?.toISOString().slice(0, 10)}</span> : null}</td>
                      <td>
                        {row.status !== 'revoked' ? (
                          <>
                            <a href={`/portal/transcripts/${encodeURIComponent(row.serial)}`}>Print</a>
                            <form action={revoke} style={{ display: 'inline', marginLeft: 12 }}>
                              <input type="hidden" name="serial" value={row.serial} />
                              <input type="hidden" name="admission" value={loaded.admissionNumber} />
                              <input name="reason" placeholder="Reason (min 10 characters)" required minLength={10} maxLength={255} style={{ width: 220 }} />
                              <button type="submit" className="danger">Revoke</button>
                            </form>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : null}
    </>
  );
}
