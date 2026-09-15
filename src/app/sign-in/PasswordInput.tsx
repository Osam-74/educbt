'use client';

import { useState } from 'react';
import { PaIcon } from '@/app/platform/icons';

/**
 * Password field with a show/hide toggle. Visibility state is CLIENT-only —
 * the value is never anything the server needs to know about. The text
 * "Show/Hide" label became the standard eye / eye-off icon pair (same
 * control as the Platform Admin forms) — behaviour unchanged.
 */
export default function PasswordInput({ id = 'password' }: { id?: string }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-row">
      <input
        id={id}
        name="password"
        type={visible ? 'text' : 'password'}
        autoComplete="current-password"
        required
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        aria-controls={id}
      >
        <PaIcon name={visible ? 'eyeOff' : 'eye'} width={16} height={16} />
      </button>
    </div>
  );
}
