'use client';

import { useState } from 'react';

/**
 * Password field with a show/hide toggle. Visibility state is CLIENT-only —
 * the value is never anything the server needs to know about.
 */
export default function PasswordInput({ id = 'password' }: { id?: string }) {
  const [visible, setVisible] = useState(false);

  return (
    <>
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
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </>
  );
}
