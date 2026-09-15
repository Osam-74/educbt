'use client';
import { useActionState } from 'react';
import Link from 'next/link';
import { resultAction } from './actions';
import type { ResultScope } from '@/lib/results/config';

/**
 * One row of the Results classes table — the plugin's per-class action
 * cluster (results.php): Compile / Recompile, Review & Moderate at the
 * compiled and reviewed stages, the forward lifecycle step, and the
 * Broadsheet link. Backward corrections (reopen, withdraw, unlock) stay
 * available to the principal behind the row's "Correction" toggle, with
 * the audited written reason the lifecycle requires.
 */
export function ClassRow({ scope, stage, principal, configured }: {
  scope: ResultScope; stage: string; principal: boolean; configured: boolean;
}) {
  const [state, action, pending] = useActionState(resultAction, { ok: false, message: '' });

  const forward: Record<string, [string, string]> = {
    compiled: ['reviewed', 'Sign off review'],
    reviewed: ['published', 'Publish to students and parents'],
    published: ['locked', 'Lock results'],
  };
  const backward: Record<string, [string, string]> = {
    reviewed: ['compiled', 'Reopen for correction'],
    published: ['reviewed', 'Withdraw publication'],
    locked: ['published', 'Unlock results'],
  };

  return (
    <form action={action} className="class-actions">
      <input type="hidden" name="classId" value={scope.classId} />
      <input type="hidden" name="sessionId" value={scope.sessionId} />
      <input type="hidden" name="termId" value={scope.termId} />

      {(stage === '' || stage === 'draft' || stage === 'mixed') && (
        <button type="submit" name="operation" value="compile" disabled={!configured || pending}>
          {stage === '' ? 'Compile' : 'Recompile'}
        </button>
      )}

      {(stage === 'compiled' || stage === 'reviewed') && (
        <Link className="btn-link" href={`/portal/review/${scope.classId}`}>Review &amp; Moderate</Link>
      )}

      {forward[stage] && (
        <button type="submit" name="operation" value={forward[stage]![0]} className="primary" disabled={pending || !principal}>
          {forward[stage]![1]}
        </button>
      )}

      {stage !== '' && (
        <Link className="btn-link" href={`/portal/broadsheet?class=${scope.classId}`}>Broadsheet</Link>
      )}

      {principal && backward[stage] && (
        <details className="class-correction">
          <summary>Correction…</summary>
          <textarea name="reason" rows={2} maxLength={2000}
            placeholder="Written correction reason (at least 10 characters)." />
          <button type="submit" name="operation" value={backward[stage]![0]} disabled={pending}>
            {backward[stage]![1]}
          </button>
          <p className="muted">Each reversal is audited with your reason.</p>
        </details>
      )}

      {pending && <span role="status" className="muted">Updating…</span>}
      {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
    </form>
  );
}
