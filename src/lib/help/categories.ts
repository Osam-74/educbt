import type { HelpCategory, HelpCategoryId } from './types';

export const CATEGORIES: HelpCategory[] = [
  { id: 'getting-started', title: 'Getting Started', icon: 'flag', description: 'What EduCBT is, how to find your way around, and how a new school gets going.' },
  { id: 'school-management', title: 'School Management', icon: 'school', description: 'Students, staff, classes, subjects and your school settings.' },
  { id: 'examinations', title: 'Examinations', icon: 'exam', description: 'Question banks, approvals, papers, timetables, invigilation and marking.' },
  { id: 'results', title: 'Results & Records', icon: 'results', description: 'Recording scores, results, report cards and what students and parents see.' },
  { id: 'account-security', title: 'Account & Security', icon: 'lock', description: 'Signing in, passwords, recovery and two-factor security.' },
  { id: 'troubleshooting', title: 'Troubleshooting', icon: 'wrench', description: 'Step-by-step checks when something is not working.' },
  { id: 'faq', title: 'Frequently Asked Questions', icon: 'faq', description: 'Quick answers, grouped by who is asking.' },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<HelpCategoryId, HelpCategory>;
