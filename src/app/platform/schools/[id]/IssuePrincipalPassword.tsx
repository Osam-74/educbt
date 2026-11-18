'use client';

import { useActionState, useState } from 'react';
import { issuePrincipalPasswordAction, type IssuePasswordState } from './actions';
import { CopyButton } from '../../CopyButton';

/**
 * Issue the principal a new temporary password. Needed after restoring a school from a backup that did
 * not include passwords, and for a principal who is locked out. The result is shown ONCE.
 */
export function IssuePrincipalPassword({ schoolId, disabledReason }: { schoolId: number; disabledReason: string | null }) {
  const [state, action, pending] = useActionState<IssuePasswordState, FormData>(issuePrincipalPasswordAction, { status: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const showing = state.status === 'success' && !dismissed;

  return (
    <div id="issue-principal-password">
      <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Principal password</h3>
      <p className="pa-field-hint" style={{ margin: '0 0 10px' }}>
        Issue the principal a new temporary password. Use it after restoring a school from a backup that did not keep
        passwords, or when the principal is locked out. They are asked to choose their own at first sign-in.
      </p>

      {showing && state.status === 'success' ? (
        <div className="pa-alert pa-alert--ok" role="status" data-testid="issued-password" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div>
            <strong>{state.result.name}</strong> signs in with <strong>{state.result.loginId}</strong> and this temporary password:
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
            <strong data-testid="temp-password" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 16 }}>{state.result.temporaryPassword}</strong>
            <CopyButton value={state.result.temporaryPassword} label="Copy" ghost />
          </div>
          <div><strong>Copy it now. It will not be shown again.</strong> Their previous sessions were signed out.</div>
          <button type="button" className="pa-btn" style={{ marginTop: 10, alignSelf: 'flex-start' }} onClick={() => setDismissed(true)}>I have saved it</button>
        </div>
      ) : (
        <form action={action} onSubmit={() => setDismissed(false)}>
          <input type="hidden" name="schoolId" value={schoolId} />
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, margin: '0 0 10px' }}>
            <input type="checkbox" name="confirm" disabled={pending || !!disabledReason} style={{ marginTop: 3 }} />
            <span>I understand the principal&apos;s current password will stop working and they will be signed out.</span>
          </label>
          {disabledReason && <p className="pa-field-hint" style={{ margin: '0 0 10px' }}>{disabledReason}</p>}
          {state.status === 'error' && <p className="pa-field-error" role="alert" style={{ margin: '0 0 10px' }}>{state.message}</p>}
          <button type="submit" className="pa-btn" disabled={pending || !!disabledReason}>{pending ? 'Issuing…' : 'Issue principal password'}</button>
        </form>
      )}
    </div>
  );
}
