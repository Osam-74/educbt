import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { settingsView, SettingsError } from '@/lib/settings/service';
import { classTermSheet } from '@/lib/settings/remarks';
import { RangesEditor } from '../settings/PersonalForms';
import { TermNotesRow } from './TermNotesRow';
import '../settings/settings.css';
import '../school-table.css';
import './remarks.css';

export const dynamic = 'force-dynamic';

export default async function TeachingRemarks({ searchParams }: { searchParams: Promise<{ classId?: string }> }) {
  const actor = await requireSchoolSession();
  const q = await searchParams;
  let data, sheet;
  try {
    data = await settingsView(actor);
    sheet = data.roles.includes('class_teacher') ? await classTermSheet(actor, Number(q.classId) || null) : null;
  } catch (error) { if (error instanceof SettingsError) notFound(); throw error; }
  const initialRanges = data.ranges.find(r => r.role === 'class_teacher')?.ranges ?? [];
  // See signature/page.tsx's comment: the .school-settings wrapper is what
  // makes RangesEditor's .settings-* classes (card, table, save button)
  // actually render instead of falling back to unstyled browser defaults.
  return <div className="school-settings">
    <h1 className="page-title">Remarks</h1>
    {!sheet
      ? <p className="note">You are not the class teacher of any class, so there are no report-card remarks for you to set up.</p>
      : <>
        <section className="sa-card remarks-card">
          <h2>Remarks and attendance <span className="muted">{sheet.chosen ? `${sheet.chosen.name}` : ''}{sheet.term ? `, ${sheet.term.title}` : ''}</span></h2>
          {sheet.classes.length > 1 ? <nav className="remarks-classes" aria-label="Your classes">
            {sheet.classes.map(c => <Link key={c.id} href={`/portal/remarks?classId=${c.id}`} aria-current={c.id === sheet.chosen?.id ? 'page' : undefined}>{c.name}</Link>)}
          </nav> : null}
          {!sheet.session || !sheet.term
            ? <p className="note">There is no current session and term yet. Ask the principal to set one in School Settings.</p>
            : sheet.rows.length === 0
              ? <p className="note">There are no active pupils in this class yet.</p>
              : <>
                <p className="muted">Write each pupil&apos;s remark and enter the days present out of the days school was open. Both appear on the report card. They lock once results go for review.</p>
                <div className="sa-table-wrap"><table className="sa-table remarks-table">
                  <thead><tr><th scope="col">Pupil</th><th scope="col" colSpan={4}>Remark and attendance</th></tr></thead>
                  <tbody>{sheet.rows.map(r => <TermNotesRow key={r.studentId} row={r} sessionId={sheet.session!.id} termId={sheet.term!.id}/>)}</tbody>
                </table></div>
              </>}
        </section>
        <h2 className="remarks-sub">Automatic remark ranges</h2>
        <RangesEditor initialRanges={initialRanges}/>
      </>}
  </div>;
}
