'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PIECE_BYTES, planPieces, backoffMs, isRetryable, MAX_ATTEMPTS, percent, formatBytes } from '@/lib/school-backup/chunker';

type Phase = 'idle' | 'hashing' | 'uploading' | 'finishing' | 'restoring' | 'done' | 'failed';
type JobStatus = { status: string; errorMessage: string | null; restoredSchoolId: number | null; summary: Record<string, number> | null };

async function sha256Hex(file: File): Promise<string> {
  // Web Crypto has no streaming digest, so the file is read once into memory to hash it. The supported
  // maximum is 150 MB, which a desktop browser handles; the pieces are then sliced from the File itself,
  // not from this buffer, so it is released as soon as the hash is computed.
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function send(url: string, init: RequestInit): Promise<{ status: number | null; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { ...init, credentials: 'same-origin' });
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { status: null, json: null };
  }
}

export function RestoreUploader() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [code, setCode] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [name, setName] = useState('');
  const [sent, setSent] = useState(0);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [job, setJob] = useState<JobStatus | null>(null);
  const jobId = useRef<number | null>(null);
  const [waitedMs, setWaitedMs] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const aborted = useRef(false);

  const busy = phase === 'hashing' || phase === 'uploading' || phase === 'finishing' || phase === 'restoring';

  // Poll the background restore until it ends.
  useEffect(() => {
    if (phase !== 'restoring' || jobId.current == null) return;
    let stop = false;
    const tick = async () => {
      const r = await send(`/api/platform/school-backup/upload/${jobId.current}/status`, { method: 'GET' });
      if (stop) return;
      const j = (r.json?.job ?? null) as (JobStatus & { status: string }) | null;
      if (j) {
        setJob(j);
        if (j.status === 'succeeded') { setPhase('done'); return; }
        if (j.status === 'failed' || j.status === 'cancelled') { setPhase('failed'); setMessage(j.errorMessage ?? 'The restore did not complete.'); return; }
      }
      setTimeout(tick, 2500);
    };
    const t = setTimeout(tick, 1500);
    const began = Date.now();
    const clock = setInterval(() => setWaitedMs(Date.now() - began), 1000);
    return () => { stop = true; clearTimeout(t); clearInterval(clock); };
  }, [phase]);

  // A job that is verified but never picked up means the background service is not receiving the signal.
  const stuckQueued = phase === 'restoring' && job?.status === 'queued' && waitedMs > 45_000;

  async function retryQueue() {
    if (jobId.current == null) return;
    setRetrying(true); setMessage(null);
    const r = await send(`/api/platform/school-backup/upload/${jobId.current}/retry`, { method: 'POST' });
    setRetrying(false);
    setMessage(r.status === 200 ? 'Signal sent again. Waiting for the restore to start.' : String(r.json?.message ?? 'Could not send the signal again.'));
    if (r.status === 200) setWaitedMs(0);
  }

  const sendPiece = useCallback(async (id: number, position: number, blob: Blob): Promise<boolean> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (aborted.current) return false;
      const r = await send(`/api/platform/school-backup/upload/${id}/chunk/${position}`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
      if (r.status === 200) return true;
      if (!isRetryable(r.status)) { setMessage(String(r.json?.message ?? 'A piece of the file was refused.')); return false; }
      await new Promise((res) => setTimeout(res, backoffMs(attempt)));
    }
    setMessage('The connection kept failing. Check your internet and upload again.');
    return false;
  }, []);

  async function start() {
    if (!file) return;
    aborted.current = false; setMessage(null); setJob(null); setSent(0);
    try {
      setPhase('hashing');
      const sha256 = await sha256Hex(file);
      const pieces = planPieces(file.size);
      setTotal(pieces.length);

      const begun = await send('/api/platform/school-backup/upload/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, totalBytes: file.size, totalChunks: pieces.length, sha256, code: code.trim(), subdomain: subdomain.trim() || null, name: name.trim() || undefined }),
      });
      if (begun.status !== 200 || !begun.json?.ok) { setPhase('failed'); setMessage(String(begun.json?.message ?? 'The upload could not be started.')); return; }
      const id = Number(begun.json.jobId); jobId.current = id;

      setPhase('uploading');
      let done = 0;
      for (const p of pieces) {
        const ok = await sendPiece(id, p.position, file.slice(p.start, p.end));
        if (!ok) { setPhase('failed'); return; }
        setSent(++done);
      }

      setPhase('finishing');
      const fin = await send(`/api/platform/school-backup/upload/${id}/finish`, { method: 'POST' });
      if (fin.status !== 200 || !fin.json?.ok) { setPhase('failed'); setMessage(String(fin.json?.message ?? 'The upload could not be finished.')); return; }
      setPhase('restoring');
    } catch {
      setPhase('failed'); setMessage('Something went wrong reading the file. Try again.');
    }
  }

  const pct = percent(sent, total, phase === 'done' || phase === 'restoring');
  const ready = !!file && /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/.test(code.trim()) && (!subdomain.trim() || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain.trim()));

  return (
    <div className="pa-card pa-card-pad">
      {phase === 'done' && job ? (
        <div>
          <div className="pa-alert pa-alert--ok" role="status"><div><strong>School restored.</strong> Everything in the backup is now a new school, and the original was not touched.</div></div>
          {job.summary && (
            <p className="pa-field-hint" style={{ marginTop: 12 }}>
              {Object.entries(job.summary).filter(([, n]) => n > 0).map(([t, n]) => `${n} ${t.replace(/_/g, ' ')}`).join(' · ')}
            </p>
          )}
          <p className="pa-field-hint" style={{ marginTop: 12 }}>
            If the file did not include passwords, open the school and choose <strong>Issue principal password</strong> so someone can sign in.
          </p>
          {job.restoredSchoolId && <a className="pa-btn pa-btn--primary" style={{ marginTop: 12, display: 'inline-block' }} href={`/platform/schools/${job.restoredSchoolId}`}>Open the restored school</a>}
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void start(); }} noValidate>
          <div className="pa-field">
            <label htmlFor="bk-file">Backup file</label>
            <input id="bk-file" className="pa-input" type="file" accept=".gz,.educbt-school.gz,application/gzip" disabled={busy}
              onChange={(e) => { setFile(e.target.files?.[0] ?? null); setMessage(null); setPhase('idle'); }} />
            {file && <p className="pa-field-hint">{file.name} · {formatBytes(file.size)} · sent in {planPieces(file.size).length} piece{planPieces(file.size).length === 1 ? '' : 's'} of up to {formatBytes(PIECE_BYTES)}</p>}
          </div>
          <div className="pa-field">
            <label htmlFor="bk-code">New school code <span className="pa-required">*</span></label>
            <input id="bk-code" className="pa-input" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} placeholder="e.g. GREENFIELD" autoComplete="off" />
            <p className="pa-field-hint">Must be new. The backup&apos;s own code is never reused, so nothing existing can be overwritten.</p>
          </div>
          <div className="pa-field">
            <label htmlFor="bk-name">School name <span className="pa-optional">(optional, defaults to the name in the file)</span></label>
            <input id="bk-name" className="pa-input" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
          <div className="pa-field">
            <label htmlFor="bk-sub">Subdomain <span className="pa-optional">(optional)</span></label>
            <input id="bk-sub" className="pa-input" value={subdomain} disabled={busy} onChange={(e) => setSubdomain(e.target.value.toLowerCase())} placeholder="e.g. greenfield" autoComplete="off" />
          </div>

          {busy && (
            <div style={{ margin: '16px 0' }} aria-live="polite">
              <div style={{ height: 8, borderRadius: 999, background: 'var(--pa-stone-200)', overflow: 'hidden' }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${pct}%`, height: '100%', background: 'var(--pa-emerald-600, #059669)', transition: 'width .3s' }} />
              </div>
              <p className="pa-field-hint" style={{ marginTop: 8 }}>
                {phase === 'hashing' && 'Checking the file…'}
                {phase === 'uploading' && `Uploading piece ${Math.min(sent + 1, total)} of ${total}… keep this page open.`}
                {phase === 'finishing' && 'Verifying the upload…'}
                {phase === 'restoring' && 'Restoring the school in the background. You can leave this page; the restore keeps going.'}
              </p>
            </div>
          )}

          {stuckQueued && (
            <div className="pa-alert" role="status" style={{ margin: '12px 0', background: '#fffbeb', border: '1px solid #fde68a', color: '#78350f' }}>
              <div>
                <strong>The restore has not started.</strong> The file was uploaded and checked, but the background service has not picked it up.
                Nothing has been restored. Send the signal again; it is safe to do more than once.
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="pa-btn" onClick={() => void retryQueue()} disabled={retrying}>{retrying ? 'Sending…' : 'Send the signal again'}</button>
                </div>
              </div>
            </div>
          )}

          {message && <div className={phase === 'restoring' ? 'pa-alert pa-alert--ok' : 'pa-alert pa-alert--error'} role="alert" style={{ margin: '12px 0' }}><div>{message}</div></div>}

          <button type="submit" className="pa-btn pa-btn--primary" disabled={!ready || busy}>
            {busy ? 'Working…' : phase === 'failed' ? 'Try again' : 'Upload and restore'}
          </button>
        </form>
      )}
    </div>
  );
}
