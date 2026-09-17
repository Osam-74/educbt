'use client';

import PendingButton from '@/app/PendingButton';

/**
 * "Delete" on a draft examination — the plugin's inline
 * `onsubmit="return confirm(…)"`, ported. The server action re-checks the
 * series is still a draft; this is just the "are you sure" gate.
 */
export default function DeleteSeriesButton({ title }: { title: string }) {
  return (
    <PendingButton
      className="sa-btn sa-btn--danger sa-btn--small"
      pendingLabel="Deleting…"
      onClick={(e) => {
        if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) e.preventDefault();
      }}
    >
      Delete
    </PendingButton>
  );
}
