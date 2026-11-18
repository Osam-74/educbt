'use client';

import { useState } from 'react';

/**
 * Download a backup. POST (it writes an audit entry), then save the streamed body as a file.
 * The password option is OFF by default and says plainly what it costs.
 */
export function BackupDownload({ schoolId, schoolName }: { schoolId: number; schoolName: string }) {
  const [withPasswords, setWithPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function download() {
    setBusy(true); setError(null); setDone(null);
    try {
      const res = await fetch(`/api/platform/school-backup/download/${schoolId}${withPasswords ? '?passwords=1' : ''}`, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(j?.message ?? 'The backup could not be created.');
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${schoolName}-backup.educbt-school.gz`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDone(name);
    } catch {
      setError('The download was interrupted. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Backup</h3>
      <p className="pa-field-hint" style={{ margin: '0 0 10px' }}>
        A complete copy of this school: people, subjects, classes, questions, results, photos and the logo. Use it to
        restore the school as a new one, here or on another platform.
      </p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, margin: '0 0 10px' }}>
        <input type="checkbox" checked={withPasswords} onChange={(e) => setWithPasswords(e.target.checked)} disabled={busy} style={{ marginTop: 3 }} />
        <span>
          Keep everyone&apos;s current password
          <span className="pa-field-hint" style={{ display: 'block', marginTop: 2 }}>
            {withPasswords
              ? 'The file will contain each person\u2019s password hash. Store it like a password list: anyone who gets it can try to crack weak passwords offline. Its name will end in WITH-PASSWORDS.'
              : 'Off (recommended): the file holds no passwords, so a lost copy cannot be used to sign in. After a restore, the principal is issued a new password.'}
          </span>
        </span>
      </label>
      {error && <div className="pa-alert pa-alert--error" role="alert" style={{ margin: '0 0 10px' }}><div>{error}</div></div>}
      {done && <div className="pa-alert pa-alert--ok" role="status" style={{ margin: '0 0 10px' }}><div>Saved <strong>{done}</strong>. This download was recorded in the school&apos;s activity log.</div></div>}
      <button type="button" className="pa-btn" onClick={() => void download()} disabled={busy}>{busy ? 'Preparing backup…' : 'Download backup'}</button>
    </div>
  );
}
