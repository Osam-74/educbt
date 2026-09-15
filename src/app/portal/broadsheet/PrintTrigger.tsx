'use client';
/**
 * Download / Print — the plugin prints via the browser's own print-to-PDF
 * (window.print, broadsheet.php's inline script). The print stylesheet sets
 * landscape for the broadsheet document and repeats the header across pages,
 * which is what a broadsheet needs.
 */
export function PrintTrigger() {
  return (
    <button type="button" className="broad-controls__btn" onClick={() => window.print()}>
      Download / Print
    </button>
  );
}
