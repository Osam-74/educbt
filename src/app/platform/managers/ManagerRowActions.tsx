'use client';

/**
 * Per-manager row actions: Suspend/Reactivate (plain form, redirects — no
 * secret to show), Reset password (useActionState so the one-time
 * temporary password can be shown inline without leaving the page, same
 * one-time-view convention as ManagersForm's create flow), and Delete
 * (plain form with a confirm prompt — permanent, distinct from suspend).
 */

import { useActionState, useState } from 'react';
import { setManagerStatusAction, resetManagerPasswordAction, deleteManagerAction, type ManagerPasswordResetState } from './actions';
import { CopyButton } from '../CopyButton';

export function ManagerRowActions({
  managerId,
  loginId,
  active,
}: {
  managerId: number;
  loginId: string;
  active: boolean;
}) {
  const [resetOpen, setResetOpen] = useState(false);
  const [resetState, resetAction, resetPending] = useActionState<ManagerPasswordResetState, FormData>(
    resetManagerPasswordAction,
    { status: 'idle' },
  );

  if (resetState.status === 'success') {
    return (
      <div className="pa-cred-card" style={{ margin: 0, maxWidth: 260 }}>
        <div className="pa-cred-head">
          <span>New password</span>
          <span className="pa-cred-onetime">One-time view</span>
        </div>
        <div className="pa-cred-row">
          <span>Temporary password</span>
          <div className="pa-cred-password-box">
            <strong style={{ fontFamily: 'ui-monospace, monospace' }}>{resetState.result.temporaryPassword}</strong>
            <CopyButton value={resetState.result.temporaryPassword} label="Copy" ghost />
          </div>
        </div>
        <button
          type="button"
          className="pa-btn pa-btn--outline pa-btn--sm pa-btn--block"
          style={{ marginTop: 8 }}
          onClick={() => setResetOpen(false)}
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      <form action={setManagerStatusAction}>
        <input type="hidden" name="managerId" value={managerId} />
        <input type="hidden" name="status" value={active ? 'suspended' : 'active'} />
        <button
          type="submit"
          className={active ? 'pa-btn pa-btn--danger pa-btn--sm' : 'pa-btn pa-btn--outline pa-btn--sm'}
          title={active ? 'Suspend this manager' : 'Reactivate this manager'}
        >
          {active ? 'Suspend' : 'Reactivate'}
        </button>
      </form>

      {resetOpen ? (
        <form action={resetAction}>
          <input type="hidden" name="managerId" value={managerId} />
          <button type="submit" disabled={resetPending} className="pa-btn pa-btn--outline pa-btn--sm" title="Issue a new temporary password">
            {resetPending ? 'Resetting…' : 'Confirm reset'}
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="pa-btn pa-btn--outline pa-btn--sm"
          title={`Reset ${loginId}'s password`}
          onClick={() => setResetOpen(true)}
        >
          Reset password
        </button>
      )}
      {resetState.status === 'error' ? (
        <p className="pa-field-error" style={{ width: '100%', textAlign: 'right', margin: '2px 0 0' }}>{resetState.message}</p>
      ) : null}

      <form
        action={deleteManagerAction}
        onSubmit={(e) => {
          if (!window.confirm(`Delete manager ${loginId}? This permanently removes the account — it cannot be undone.`)) {
            e.preventDefault();
          }
        }}
      >
        <input type="hidden" name="managerId" value={managerId} />
        <button type="submit" className="pa-btn pa-btn--danger pa-btn--sm" title="Permanently delete this manager account">
          Delete
        </button>
      </form>
    </div>
  );
}
