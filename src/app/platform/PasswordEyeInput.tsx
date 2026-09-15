'use client';

import { useState } from 'react';
import { PaIcon } from './icons';

/**
 * Password input with a show/hide eye toggle — the Platform Admin companion
 * to /sign-in's PasswordInput. Purely CLIENT-side visibility: the submitted
 * value is exactly what the user typed either way, so no server behaviour,
 * autocomplete contract, or validation is affected by the toggle.
 *
 * Wraps the standard .pa-input styling; the eye button overlays the field's
 * right edge inside a .pa-password-eye wrapper.
 */
export default function PasswordEyeInput({
  id,
  name,
  autoComplete,
  placeholder,
  required,
  minLength,
  defaultValue,
}: {
  id: string;
  name: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
  minLength?: number;
  defaultValue?: string | number;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="pa-password-eye">
      <input
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        placeholder={placeholder}
        required={required}
        minLength={minLength}
        defaultValue={defaultValue}
        className="pa-input"
      />
      <button
        type="button"
        className="pa-password-eye-toggle"
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
