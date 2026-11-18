import Link from 'next/link';
import { requirePlatformSession } from '@/lib/platform/session';
import { listJobs, STALE_RESTORE_MINUTES } from '@/lib/school-backup/upload';
import { formatBytes } from '@/lib/school-backup/chunker';
import { RestoreUploader } from './RestoreUploader';
import { cancelRestoreAction, failStaleRestoreAction, retryRestoreAction } from './actions';

export const dynamic = 'force-dynamic';

const PILL: Record<string, string> = {
  succeeded: 'pa-pill pa-pill--active', failed: 'pa-pill pa-pill--suspended', cancelled: 'pa-pill pa-pill--archived',
  uploading: 'pa-pill pa-pill--archived', queued: 'pa-pill pa-pill--archived', restoring: 'pa-pill pa-pill--archived',
};
const LABEL: Record<string, string> = {
  uploading: 'Uploading', queued: 'Waiting to start', restoring: 'Restoring', succeeded: 'Restored', failed: 'Failed', cancelled: 'Cancelled',
};

export default async function RestoreSchoolPage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const actor = await requirePlatformSession();
  const flash = await searchParams;
  const jobs = await listJobs(actor.userId, 15);
  const staleCutoff = Date.now() - STALE_RESTORE_MINUTES * 60_000;

  return (
    <div style={{ maxWidth: 820, margin: '0 auto' }}>
      <div className="pa-page-head" style={{ marginBottom: 20 }}>
        <div>
          <h1>Restore a school from a backup</h1>
          <p>
            Upload a backup file to create a <strong>new</strong> school with everything in it: students, staff and their
            assignments, subjects, classes, timetables, questions, results, photos and the school logo. It never overwrites
            an existing school.
          </p>
        </div>
        <Link href="/platform/schools" className="pa-btn">Back to schools</Link>
      </div>

      {flash.ok && <div className="pa-alert pa-alert--ok" role="status" style={{ marginBottom: 14 }}><div>{flash.ok}</div></div>}
      {flash.error && <div className="pa-alert pa-alert--error" role="alert" style={{ marginBottom: 14 }}><div>{flash.error}</div></div>}

      <RestoreUploader />

      <h2 style={{ margin: '28px 0 4px', fontSize: 16 }}>Recent uploads</h2>
      {jobs.length === 0 ? (
        <p className="pa-field-hint">Nothing has been uploaded yet.</p>
      ) : (
        <div className="pa-card"><div className="pa-table-wrap" style={{ marginTop: 0 }}>
          <table className="pa-table">
            <thead><tr><th>File</th><th>New code</th><th>Status</th><th>When</th><th className="pa-right">Action</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.fileName}<div className="pa-field-hint">{formatBytes(j.totalBytes)}</div></td>
                  <td className="pa-num">{j.newSchoolCode}</td>
                  <td>
                    <span className={PILL[j.status] ?? 'pa-pill'}>{LABEL[j.status] ?? j.status}</span>
                    {j.status === 'uploading' && <div className="pa-field-hint">{j.receivedChunks} of {j.totalChunks} pieces</div>}
                    {j.status === 'failed' && j.errorMessage && <div className="pa-field-hint" style={{ color: 'var(--pa-rose-700)' }}>{j.errorMessage}</div>}
                  </td>
                  <td>{new Date(j.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td className="pa-right">
                    {j.status === 'succeeded' && j.restoredSchoolId && <Link className="pa-btn" href={`/platform/schools/${j.restoredSchoolId}`}>Open school</Link>}
                    {j.status === 'queued' && (
                      <span style={{ display: 'inline-flex', gap: 6 }}>
                        <form action={retryRestoreAction}><input type="hidden" name="jobId" value={j.id} /><button className="pa-btn" type="submit">Start again</button></form>
                        <form action={cancelRestoreAction}><input type="hidden" name="jobId" value={j.id} /><button className="pa-btn" type="submit">Cancel</button></form>
                      </span>
                    )}
                    {j.status === 'uploading' && <form action={cancelRestoreAction}><input type="hidden" name="jobId" value={j.id} /><button className="pa-btn" type="submit">Cancel</button></form>}
                    {j.status === 'restoring' && new Date(j.updatedAt).getTime() < staleCutoff && (
                      <form action={failStaleRestoreAction}><input type="hidden" name="jobId" value={j.id} /><button className="pa-btn" type="submit">Reset stalled restore</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      )}
    </div>
  );
}
