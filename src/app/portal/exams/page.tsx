import { requireSchoolSession, requireRole, SCHOOL_WIDE } from '@/lib/session';
import { examOfficeDashboard } from '@/lib/exam/dashboard';
import ExamOfficeDashboard from './ExamOfficeDashboard';

export const dynamic = 'force-dynamic';

/**
 * Overview (legacy templates/portal/exams/index.php, section slug '').
 *
 * Stats, this term's pipeline and what's coming up — the office's landing
 * page. Browsing and creating exams/papers lives at Exam Papers
 * (/portal/exams/papers), one menu step over, matching the plugin's own
 * split between its Overview and its Exam Papers page.
 */
export default async function ExamsPage() {
  const actor = await requireSchoolSession();
  // The menu hides this link for other roles; the server refuses regardless.
  requireRole(actor, SCHOOL_WIDE);

  const dashboard = await examOfficeDashboard(actor);

  return <ExamOfficeDashboard data={dashboard} />;
}
