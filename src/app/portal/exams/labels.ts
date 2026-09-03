/**
 * Plain-language labels for the Exam Office.
 *
 * Staff see "Examination" and "Papers ready", not enum values — the words in
 * the database are for the code, the words here are for people.
 */

export const TYPE_LABEL: Record<string, string> = {
  examination: 'Examination',
  ca_test: 'CA Test',
  practice: 'Practice',
};

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Preparing',
  open: 'Collecting questions',
  composed: 'Papers ready',
  published: 'Published',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** Renders in West Africa Time — the sitting timetable a Nigerian school reads. */
export function fmtDay(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric',
  }).format(d);
}

export function fmtTime(d: Date | null): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(d);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}
