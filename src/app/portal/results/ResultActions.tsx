'use client';
import { useActionState } from 'react';
import { resultAction } from './actions';
import type { ResultScope } from '@/lib/results/config';
export function ResultActions({ scope, stage, principal, configured }: {
  scope: ResultScope; stage: string; principal: boolean; configured: boolean;
}) {
  const [state, action, pending] = useActionState(resultAction, { ok: false, message: '' });
  const forward: Record<string, [string, string]> = {
    compiled: ['reviewed', 'Sign off review'], reviewed: ['published', 'Publish to students and parents'], published: ['locked', 'Lock results'],
  };
  const backward: Record<string, [string, string]> = {
    reviewed: ['compiled', 'Reopen for correction'], published: ['reviewed', 'Withdraw publication'], locked: ['published', 'Unlock results'],
  };
  return <form action={action} className="result-actions">
    {Object.entries(scope).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
    <fieldset disabled={pending}>
      <legend>Class result actions</legend>
      {['draft', 'compiled', 'mixed'].includes(stage) && <button type="submit" name="operation" value="compile" disabled={!configured}>Compile / recompile class</button>}
      {principal && forward[stage] && <button type="submit" name="operation" value={forward[stage]![0]}>{forward[stage]![1]}</button>}
      {principal && backward[stage] && <div className="result-correction">
        <label htmlFor="result-reason">Written correction reason</label>
        <textarea id="result-reason" name="reason" rows={2} maxLength={2000} placeholder="Explain the correction (at least 10 characters)." />
        <button type="submit" name="operation" value={backward[stage]![0]}>{backward[stage]![1]}</button>
        <p>Each reversal is audited. Unlocking keeps results published; withdraw publication, then reopen before changing scores.</p>
      </div>}
    </fieldset>
    {pending && <p role="status">Updating results…</p>}
    {state.message && <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'}>{state.message}</p>}
  </form>;
}
