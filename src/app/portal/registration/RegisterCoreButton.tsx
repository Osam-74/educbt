'use client';

import { useActionState } from 'react';
import { registerCoreAction, EMPTY } from './actions';

/**
 * "Register these for the whole class" — legacy teacher/registration.php's
 * bulk action. Additive only (see registerCoreForClass): never resets or
 * touches electives, so it is always safe to click again.
 */
export function RegisterCoreButton({ classId }: { classId: number }) {
  const [state, action, pending] = useActionState(registerCoreAction, EMPTY);

  return (
    <form action={action} style={{ marginTop: 12 }}>
      <input type="hidden" name="classId" value={classId} />
      <button type="submit" disabled={pending} className="sa-btn sa-btn--primary">
        {pending ? 'Registering…' : 'Register these for the whole class'}
      </button>
      <p className="muted" style={{ marginTop: 6, fontSize: 13 }}>
        Adds anything missing. Electives students have already chosen stay as they are.
      </p>
      {state.message && (
        <p role={state.ok ? 'status' : 'alert'} className={state.ok ? 'note' : 'error'} style={{ marginTop: 8 }}>
          {state.message}
        </p>
      )}
    </form>
  );
}
