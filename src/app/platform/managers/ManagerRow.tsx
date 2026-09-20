'use client';

/**
 * One manager, one row. The row itself only ever shows a single "Manage"
 * button (same convention as the school portal's Students/Staff tables) —
 * Suspend/Reactivate, Reset password and Delete used to sit directly in the
 * row as four buttons and made the whole table feel cramped. They now live
 * in a details row that expands underneath, exactly like a staff/student
 * edit row.
 */

import { useActionState, useState } from 'react';
import { setManagerStatusAction, resetManagerPasswordAction, deleteManagerAction, type ManagerPasswordResetState } from './actions';
import { CopyButton } from '../CopyButton';

export type ManagerRowData = {
  id: number;
  loginId: string;
  email: string | null;
  totpEnabled: boolean;
  status: string;
  createdAt: Date;
};

export function ManagerRow({ manager, isSelf }: { manager: ManagerRowData; isSelf: boolean }) {
  const [open, setOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetDismissed, setResetDismissed] = useState(false);
  const [resetState, resetAction, resetPending] = useActionState<ManagerPasswordResetState, FormData>(
    resetManagerPasswordAction,
    { status: 'idle' },
  );

  const active = manager.status === 'active';
  const showingNewPassword = resetState.status === 'success' && !resetDismissed;

  return (
    <>
      <tr id={`managers-row-${manager.id}`}>
        <td>
          <strong>{manager.loginId}</strong>
          {isSelf ? (
            <span className="pa-pill" style={{ marginLeft: 8, background: 'var(--pa-emerald-50)', color: 'var(--pa-emerald-800)' }}>You</span>
          ) : null}
        </td>
        <td style={{ fontSize: 12.5 }}>
          {manager.email ?? <span style={{ color: 'var(--pa-stone-400)' }}>—</span>}
        </td>
        <td style={{ fontSize: 12.5 }}>
          {manager.totpEnabled ? (
            <span style={{ color: 'var(--pa-emerald-700)', fontWeight: 600 }}>On</span>
          ) : (
            <span style={{ color: 'var(--pa-stone-400)' }}>Not set up</span>
          )}
        </td>
        <td>
          <span className={active ? 'pa-pill pa-pill--active' : 'pa-pill pa-pill--suspended'}>
            {manager.status}
          </span>
        </td>
        <td style={{ color: 'var(--pa-stone-500)', fontSize: 12.5 }}>
          {manager.createdAt.toLocaleDateString('en-GB')}
        </td>
        <td className="pa-right">
          {isSelf ? (
            <span style={{ fontSize: 12, color: 'var(--pa-stone-400)' }}>Current session</span>
          ) : (
            <button type="button" className="pa-btn pa-btn--outline pa-btn--sm" onClick={() => setOpen(!open)}>
              {open ? 'Close' : 'Manage'}
            </button>
          )}
        </td>
      </tr>

      {open && !isSelf ? (
        <tr>
          <td colSpan={6} style={{ background: 'var(--pa-stone-50)', padding: '16px 20px' }}>
            {showingNewPassword ? (
              <div className="pa-cred-card" style={{ margin: 0, maxWidth: 300 }}>
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
                  onClick={() => { setResetDismissed(true); setResetOpen(false); }}
                >
                  Done
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <form action={setManagerStatusAction}>
                  <input type="hidden" name="managerId" value={manager.id} />
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
                    <input type="hidden" name="managerId" value={manager.id} />
                    <button type="submit" disabled={resetPending} className="pa-btn pa-btn--outline pa-btn--sm" title="Issue a new temporary password">
                      {resetPending ? 'Resetting…' : 'Confirm reset'}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="pa-btn pa-btn--outline pa-btn--sm"
                    title={`Reset ${manager.loginId}'s password`}
                    onClick={() => { setResetOpen(true); setResetDismissed(false); }}
                  >
                    Reset password
                  </button>
                )}

                <form
                  action={deleteManagerAction}
                  onSubmit={(e) => {
                    if (!window.confirm(`Delete manager ${manager.loginId}? This permanently removes the account — it cannot be undone.`)) {
                      e.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="managerId" value={manager.id} />
                  <button type="submit" className="pa-btn pa-btn--danger pa-btn--sm" title="Permanently delete this manager account">
                    Delete
                  </button>
                </form>

                {resetState.status === 'error' ? (
                  <p className="pa-field-error" style={{ width: '100%', margin: '2px 0 0' }}>{resetState.message}</p>
                ) : null}
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
