import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { settingsView, SettingsError } from '@/lib/settings/service';
import { resultConfig } from '@/lib/results/config';
import { defaultConfig } from '@/lib/settings/validation';
import { SettingsEditor } from './SettingsEditor';
import './settings.css';
export const dynamic = 'force-dynamic';

export default async function SchoolSettings() {
  const actor = await requireSchoolSession();
  let data;
  try { data = await settingsView(actor); } catch (error) { if (error instanceof SettingsError) notFound(); throw error; }
  return <SettingsEditor canEdit={actor.role === 'principal'} school={data.school} roles={data.roles} students={data.students}
    sessions={data.sessions.map(s => ({ ...s, startsOn: s.startsOn?.toISOString().slice(0, 10) ?? '', endsOn: s.endsOn?.toISOString().slice(0, 10) ?? '', createdAt: undefined }))}
    terms={data.terms.map(t => ({ ...t, startsOn: t.startsOn?.toISOString().slice(0, 10) ?? '', endsOn: t.endsOn?.toISOString().slice(0, 10) ?? '' }))}
    config={resultConfig(data.school.settings) ?? defaultConfig} configured={Boolean(resultConfig(data.school.settings))}
    assessmentInUse={data.assessmentInUse} signatures={data.signatures.map(s => ({ ...s, updatedAt: undefined }))}
    ranges={data.ranges.map(r => ({ ...r, updatedAt: undefined }))}/>;
}
