'use client';

/**
 * The manager-creation form, and the one-time credential handoff.
 *
 * Same shape as the new-school form: useActionState + createManagerAction,
 * field-level validation messages, and the temporary password shown exactly
 * once with a copy button — never stored or re-fetched. "Add another
 * manager" remounts the form (key bump), which clears the action state —
 * no full page reload, and the one-time credential is gone for good.
 */

import { useActionState, useState } from 'react';
import { createManagerAction, type ManagerCreatedState } from './actions';
import { PaIcon } from '../icons';
import { CopyButton } from '../CopyButton';

function FieldError({ field, state }: { field: string; state: ManagerCreatedState }) {
  if (state.status !== 'error') return null;
  const msg = state.fieldErrors?.[field];
  if (!msg) return null;
  return <p className="pa-field-error">{msg}</p>;
}

function ManagerForm({ onReset }: { onReset: () => void }) {
  const [state, formAction, pending] = useActionState(createManagerAction, {
    status: 'idle',
  } as ManagerCreatedState);

  if (state.status === 'success') {
    const { loginId, temporaryPassword } = state.result;
    return (
      <div id="manager-created-success" className="pa-success-card">
        <div className="pa-success-head">
          <div className="pa-success-icon"><PaIcon name="checkCircle" width={26} height={26} /></div>
          <div>
            <h3 style={{ margin: 0, fontSize: 19, fontWeight: 800, color: 'var(--pa-forest)' }}>
              Manager {loginId} is ready
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--pa-stone-500)' }}>
              Share these credentials once — the manager sets a new password at first sign-in.
            </p>
          </div>
        </div>

        <div className="pa-cred-card" style={{ marginTop: 18 }}>
          <div className="pa-cred-head">
            <span>Manager credentials</span>
            <span className="pa-cred-onetime">One-time view</span>
          </div>
          <div className="pa-cred-row">
            <span>Sign-in ID</span>
            <strong data-testid="manager-login-id" style={{ fontFamily: 'ui-monospace, monospace', color: 'var(--pa-lime-300)' }}>{loginId}</strong>
          </div>
          <div className="pa-cred-row">
            <span>Temporary password</span>
            <div className="pa-cred-password-box">
              <strong data-testid="temp-password" style={{ fontFamily: 'ui-monospace, monospace' }}>{temporaryPassword}</strong>
              <CopyButton value={temporaryPassword} label="Copy" ghost />
            </div>
          </div>
        </div>

        <button
          type="button"
          id="manager-created-done-btn"
          className="pa-btn pa-btn--outline pa-btn--block"
          onClick={onReset}
        >
          Add another manager
        </button>
      </div>
    );
  }

  return (
    <form action={formAction} className="pa-glass pa-form-card" id="create-manager-form" noValidate>
      {state.status === 'error' ? (
        <div className="pa-alert pa-alert--error" style={{ marginBottom: 14 }}>
          <PaIcon name="alert" width={15} height={15} />{state.message}
        </div>
      ) : null}

      <div className="pa-field">
        <label htmlFor="manager-login-id">Sign-in ID</label>
        <input
          id="manager-login-id"
          name="loginId"
          type="text"
          placeholder="PLATFORM-ADMIN-2"
          autoComplete="off"
          style={{ textTransform: 'uppercase' }}
        />
        <p className="pa-field-help">Leave empty to generate the next free ID automatically.</p>
        <FieldError field="loginId" state={state} />
      </div>

      <div className="pa-field">
        <label htmlFor="manager-email">
          Recovery email <span style={{ fontWeight: 400, color: 'var(--pa-stone-400)' }}>(optional)</span>
        </label>
        <input id="manager-email" name="email" type="text" placeholder="manager@educbt.com" autoComplete="off" />
        <p className="pa-field-help">Used for password recovery and two-factor fallback.</p>
        <FieldError field="email" state={state} />
      </div>

      <button type="submit" id="submit-create-manager-btn" disabled={pending} className="pa-btn pa-btn--primary">
        {pending ? (
          <>
            <span className="pa-spinner" />
            <span>Creating manager…</span>
          </>
        ) : (
          <span>Create manager</span>
        )}
      </button>
    </form>
  );
}

export function ManagersForm() {
  // Remounting the form clears the one-time credential from memory and
  // returns the card to its idle state — no full page reload needed.
  const [resetKey, setResetKey] = useState(0);
  return <ManagerForm key={resetKey} onReset={() => setResetKey((k) => k + 1)} />;
}
