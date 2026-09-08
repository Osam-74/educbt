'use client';

import { useActionState } from 'react';
import { saveCaScore } from './actions';
import type { CaScope } from '@/lib/ca/validation';

export function ScoreForm({ scope, studentId, name, score, maxScore }: {
  scope: CaScope; studentId: number; name: string; score: string | null; maxScore: number;
}) {
  const [state, action, pending] = useActionState(saveCaScore, { ok: false, message: '' });
  return <form action={action}>
    {Object.entries({ ...scope, studentId, maxScore }).map(([key, value]) =>
      <input key={key} type="hidden" name={key} value={value} />)}
    <label htmlFor={'score-' + studentId}>Score for {name} (out of {maxScore})</label>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <input id={'score-' + studentId} name="score" type="number" min="0" max={maxScore}
        step="0.01" required defaultValue={score ?? ''} readOnly={pending}
        aria-describedby={'status-' + studentId} style={{ width: 110 }} />
      <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Save score'}</button>
    </div>
    <p id={'status-' + studentId} role="status" aria-live="polite"
      className={state.ok ? 'ok' : state.message ? 'error' : 'muted'}>
      {state.message || (score === null ? 'Not entered' : 'Stored score: ' + score)}
    </p>
  </form>;
}
