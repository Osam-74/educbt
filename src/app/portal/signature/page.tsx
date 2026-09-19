import { notFound } from 'next/navigation';
import { requireSchoolSession } from '@/lib/session';
import { settingsView, SettingsError } from '@/lib/settings/service';
import { SignatureEditor } from '../settings/PersonalForms';

export const dynamic = 'force-dynamic';

export default async function TeachingSignature() {
  const actor = await requireSchoolSession();
  let data;
  try { data = await settingsView(actor); } catch (error) { if (error instanceof SettingsError) notFound(); throw error; }
  const signature = data.signatures.find(s => s.role === 'class_teacher');
  return <>
    <h1 className="page-title">Signature</h1>
    {!data.roles.includes('class_teacher')
      ? <p className="note">You are not the class teacher of any class, so there is no report sheet for your signature to appear on.</p>
      : <SignatureEditor signature={signature}/>}
  </>;
}
