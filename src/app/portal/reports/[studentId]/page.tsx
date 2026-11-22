import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { forSchool } from '@/db';
import { loadReportSheet } from '@/lib/reports/sheet';
import { computeReportSheet } from '@/lib/reports/sheet-compute';
import { ReportSheet } from '@/components/reports/ReportSheet';
import { PrintToolbar } from './PrintToolbar';
import { RemarkEditor } from './RemarkEditor';
import '../../../print.css';

export const dynamic = 'force-dynamic';

/**
 * One student's terminal report sheet. The loading, the derived figures and the sheet itself are shared with the
 * whole-class print, so the two always say the same thing. What stays here is only what belongs to a single sheet on
 * screen: the print toolbar and the remark editors.
 */
export default async function ReportCard({
  params,
  searchParams,
}: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const { studentId: raw } = await params;
  const query = await searchParams;
  const actor = await requireSchoolSession();
  const studentId = Number(raw);

  const data = await forSchool(actor.schoolId, (tx) => loadReportSheet(tx, actor, studentId, Number(query.term ?? 0)));
  if (!data) notFound();

  const sheet = computeReportSheet(data, studentId);
  const { term, classTeacher, editableRemarks, anyUnpublished } = sheet;

  return (
    <>
      <PrintToolbar warn={anyUnpublished ? 'Not yet published — visible to staff only.' : undefined} />
      {editableRemarks && term && actor.role === 'principal' && actor.staffId && <RemarkEditor studentId={studentId} sessionId={Number(term.sessionId)} termId={Number(term.id)} role="principal" initial={data.extras?.remarks.principal ?? ''}/>}
      {editableRemarks && term && classTeacher?.id === actor.staffId && <RemarkEditor studentId={studentId} sessionId={Number(term.sessionId)} termId={Number(term.id)} role="class_teacher" initial={data.extras?.remarks.class_teacher ?? ''}/>}

      <ReportSheet sheet={sheet} />
    </>
  );
}
