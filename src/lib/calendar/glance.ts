/**
 * The sentence shown when someone has a timetable but no lessons to list today. Pure, so the wording
 * rules are pinned by a test and the dashboard component stays free of branching copy.
 */
export function instructionalLabel(o: { haveTimetable: boolean; teachingToday: boolean; weekday: number; lessonCount: number }): string {
  if (!o.haveTimetable) return '';
  if (o.lessonCount > 0) return '';
  if (o.weekday === 6 || o.weekday === 7) return 'No lessons today. It is the weekend.';
  if (!o.teachingToday) return 'No lessons today. The school is on a break or holiday.';
  return 'No lessons scheduled for you today.';
}
