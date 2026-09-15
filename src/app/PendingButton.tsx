'use client';

import { useFormStatus } from 'react-dom';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Submit button with built-in pending feedback for server-action forms.
 *
 * While the action runs, the button disables itself (no double submits),
 * marks itself busy for assistive tech, and swaps in a spinner + label so
 * the click visibly "took" — the same feedback pattern the new-school form
 * established. `useFormStatus` reads the enclosing <form>, so this drops
 * into ANY existing server-action form without touching its action code.
 *
 * `pendingLabel` covers the common text case; pass `pendingChildren` when
 * the button's normal content is richer than text (e.g. the sidebar's
 * icon + label sign-out item) and the pending state should mirror it.
 */
export default function PendingButton({
  pendingLabel,
  children,
  pendingChildren,
  ...rest
}: {
  pendingLabel?: string;
  children: ReactNode;
  pendingChildren?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  const pendingContent = pendingChildren ?? (
    <>
      <span className="btn-spinner" aria-hidden="true" />
      {pendingLabel}
    </>
  );

  return (
    <button type="submit" disabled={pending} aria-busy={pending} {...rest}>
      {pending ? pendingContent : children}
    </button>
  );
}
