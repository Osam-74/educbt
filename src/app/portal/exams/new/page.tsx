import { redirect } from 'next/navigation';

/**
 * "Create examination" now lives inline on Exam Papers (/portal/exams/papers),
 * matching the plugin's single-page layout. This route is kept only so any
 * old link/bookmark still lands somewhere sensible.
 */
export default function NewExamRedirect() {
  redirect('/portal/exams/papers');
}
