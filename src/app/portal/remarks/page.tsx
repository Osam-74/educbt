import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { settingsView, SettingsError } from '@/lib/settings/service';
import { RangesEditor } from '../settings/PersonalForms';

export const dynamic = 'force-dynamic';

export default async function TeachingRemarks() {
  const actor = await requireSchoolSession();
  let data;
  try { data = await settingsView(actor); } catch (error) { if (error instanceof SettingsError) notFound(); throw error; }
  const initialRanges = data.ranges.find(r => r.role === 'class_teacher')?.ranges ?? [];
  return <>
    <h1 className="page-title">Remarks</h1>
    {!data.roles.includes('class_teacher')
      ? <p className="note">You are not the class teacher of any class, so there are no report-card remarks for you to set up.</p>
      : <RangesEditor initialRanges={initialRanges}/>}
  </>;
}
