'use client';

/** Same pattern as ../broadsheet/PrintTrigger.tsx — the browser's own print-to-PDF. */
export function PrintButton() {
  return (
    <button type="button" className="sa-btn no-print" onClick={() => window.print()}>
      Download PDF
    </button>
  );
}
