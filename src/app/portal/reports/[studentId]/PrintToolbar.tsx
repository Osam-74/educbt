'use client';

/**
 * Legacy print toolbar: "Download / Print" plus the hint to choose
 * "Save as PDF", because the browser's own print engine IS the supported
 * PDF path (see print.css — the rasterised html2canvas approach was
 * abandoned in the legacy system for good reason).
 */
export function PrintToolbar({ warn }: { warn?: string }) {
  return (
    <div className="doc__toolbar no-print">
      <button type="button" className="doc__print" onClick={() => window.print()}>
        Download / Print
      </button>
      <span className="doc__hint">
        Choose <strong>Save as PDF</strong> in the dialog to download a copy.
      </span>
      {warn ? <span className="doc__hint"><strong>{warn}</strong></span> : null}
    </div>
  );
}
