'use client';
/**
 * Download timetable — legacy timetable.php prints via the browser's own
 * print-to-PDF (window.print). Only appears once a schedule exists, matching
 * the plugin: nothing to download before there is a schedule to download.
 */
export function PrintTrigger() {
  return (
    <button type="button" className="sd-action sd-action--ghost" onClick={() => window.print()}>
      Download timetable
    </button>
  );
}
