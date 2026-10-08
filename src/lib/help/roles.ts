import type { HelpAudience, HelpRole } from './types';

/** The roles a person can choose on the Help home ("I'm a..."). */
export const ROLE_CHOICES: { id: HelpRole; label: string; blurb: string }[] = [
  { id: 'principal', label: 'Principal', blurb: 'Runs the school, staff, sessions and results.' },
  { id: 'vice_principal', label: 'Vice Principal', blurb: 'School-wide access alongside the Principal.' },
  { id: 'exam_officer', label: 'Examination Officer', blurb: 'Runs examinations, papers and timetables.' },
  { id: 'teacher', label: 'Teacher', blurb: 'Questions, scores, marking and class work.' },
  { id: 'student', label: 'Student', blurb: 'Taking exams, practice and viewing results.' },
  { id: 'parent', label: 'Parent', blurb: 'Following your children and exam timetables.' },
];

export const ROLE_LABEL: Record<string, string> = {
  principal: 'Principal',
  vice_principal: 'Vice Principal',
  exam_officer: 'Examination Officer',
  teacher: 'Teacher',
  student: 'Student',
  parent: 'Parent',
  platform_admin: 'Platform administrator',
};

export function isHelpRole(v: string | null | undefined): v is HelpRole {
  return !!v && v in ROLE_LABEL;
}

/** Does an article written for `audience` speak to `role`? 'all' speaks to everyone. */
export function speaksTo(audience: HelpAudience[], role: HelpRole | null): boolean {
  if (!role) return true;
  return audience.includes('all') || audience.includes(role);
}

/** "Principal, Vice Principal and Examination Officer" style label. */
export function audienceLabel(audience: HelpAudience[]): string {
  if (audience.includes('all')) return 'Everyone';
  const names = audience.map((a) => ROLE_LABEL[a] ?? a);
  if (names.length <= 1) return names[0] ?? 'Everyone';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
