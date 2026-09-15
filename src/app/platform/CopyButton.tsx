'use client';

import { useState } from 'react';
import { PaIcon } from './icons';

/** Small copy-to-clipboard button reused across the dashboard, schools list,
 * school detail and new-school success state. Presentation only — never
 * touches any server action or credential storage. */
export function CopyButton({ value, label = 'Copy', ghost = false }: { value: string; label?: string; ghost?: boolean }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`pa-copy-btn${ghost ? ' pa-copy-btn--ghost' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      title={`Copy ${label.toLowerCase()}`}
    >
      {copied ? <PaIcon name="check" width={13} height={13} /> : <PaIcon name="copy" width={13} height={13} />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}
