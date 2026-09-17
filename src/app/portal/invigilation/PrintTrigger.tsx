'use client';
/**
 * Download PDF — legacy invigilation.php prints via the browser's own
 * print-to-PDF (window.print). Placed beside the examination picker, same
 * as the plugin's own page.
 */
export function PrintTrigger() {
  return (
    <button type="button" className="sd-action sd-action--ghost" onClick={() => window.print()}>
      Download PDF
    </button>
  );
}
