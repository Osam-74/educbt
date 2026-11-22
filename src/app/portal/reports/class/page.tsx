import Link from 'next/link';
import { and, eq, asc } from 'drizzle-orm';
import { requireSchoolSession } from '@/lib/session';
import { forSchool, schema } from '@/db';
import { classReportSheets } from '@/lib/reports/class-print';
import { ReportSheet } from '@/components/reports/ReportSheet';
import { PrintToolbar } from '../[studentId]/PrintToolbar';
import '../../../print.css';

export const dynamic = 'force-dynamic';

/**
 * The whole class's terminal report sheets in one printable run, one sheet per page (plugin: Bulk Report). It is built
 * on the single report (see lib/reports/class-print.ts), so it can never show a viewer a sheet the single report
 * would refuse, and only published results are printed.
 */
export default async function ClassReports({ searchParams }: { searchParams: Promise<{ class?: string; term?: string }> }) {
  const query = await searchParams;
  const actor = await requireSchoolSession();
  const classId = Number(query.class ?? 0);
  const termId = Number(query.term ?? 0);

  if (!classId) return <main className="doc__notice"><p className="error">Choose a class to print its report sheets.</p></main>;

  const run = await forSchool(actor.schoolId, (tx) => classReportSheets(tx, actor, classId, termId));
  if (!run) {
    return <main className="doc__notice"><p className="error" role="alert">You can only print report sheets for a class you hold.</p><p><Link href="/portal/results">Back to results</Link></p></main>;
  }
  if (run.sheets.length === 0) {
    return <main className="doc__notice"><p className="error" role="alert">No published results found for students in {run.className}.</p><p className="muted">{run.enrolled} enrolled. Results must be published before report sheets can be printed.</p><p><Link href="/portal/results">Back to results</Link></p></main>;
  }

  return (
    <>
      <PrintToolbar warn={run.notPublished > 0 ? `${run.notPublished} of ${run.enrolled} students left out: their results are not published yet.` : undefined} />
      <p className="no-print doc__hint" data-testid="class-print-summary">{run.className}, {run.termTitle}: {run.sheets.length} report sheet{run.sheets.length === 1 ? '' : 's'}, in order of last name.</p>
      {run.sheets.map((sheet, i) => <ReportSheet key={sheet.student.id} sheet={sheet} breakBefore={i > 0} />)}
    </>
  );
}
