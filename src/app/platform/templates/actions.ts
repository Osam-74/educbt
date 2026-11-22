'use server';

/**
 * Server actions for document templates. Platform administrators only: requirePlatformSession() rejects everyone else
 * (a school user's session is worthless on /platform), and the service re-checks the actor and the database policy
 * refuses the write independently, so a hand-made request cannot change a school's design either.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePlatformSession } from '@/lib/platform/session';
import { PlatformPermissionError } from '@/lib/platform/schools';
import { setSchoolTemplates, setPlatformDefaultTemplates, TemplateError } from '@/lib/templates/service';
import { DOC_KINDS } from '@/lib/templates/registry';

const pick = (form: FormData) => Object.fromEntries(DOC_KINDS.map((k) => [k, String(form.get(k) ?? '')]));
const failure = (error: unknown) => error instanceof TemplateError || error instanceof PlatformPermissionError
  ? error.message : 'The templates could not be saved. Nothing was changed.';

export async function saveSchoolTemplatesAction(formData: FormData) {
  const actor = await requirePlatformSession();
  const schoolId = Number(formData.get('schoolId'));
  const back = `/platform/schools/${schoolId}/templates`;
  try { await setSchoolTemplates(actor, schoolId, pick(formData)); }
  catch (error) { redirect(`${back}?error=${encodeURIComponent(failure(error))}`); }
  revalidatePath(`/platform/schools/${schoolId}`); revalidatePath(back);
  redirect(`${back}?done=1`);
}

export async function savePlatformDefaultsAction(formData: FormData) {
  const actor = await requirePlatformSession();
  try { await setPlatformDefaultTemplates(actor, pick(formData)); }
  catch (error) { redirect(`/platform/templates?error=${encodeURIComponent(failure(error))}`); }
  revalidatePath('/platform/templates');
  redirect('/platform/templates?done=1');
}
