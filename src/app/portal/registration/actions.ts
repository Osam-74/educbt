'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import { StudentError, registerCoreForClass } from '@/lib/people/students';

export type RegistrationActionState = { ok: boolean; message: string };

export async function registerCoreAction(_previous: RegistrationActionState, form: FormData): Promise<RegistrationActionState> {
  const actor = await requireSchoolSession();
  const classId = Number(form.get('classId'));

  try {
    const result = await registerCoreForClass(actor, classId);
    revalidatePath('/portal/registration');
    if (result.coreCount === 0) {
      return { ok: false, message: 'This school has no compulsory subjects defined yet. The school office sets these under Subjects.' };
    }
    const added = result.studentsUpdated - result.alreadyComplete;
    return {
      ok: true,
      message: added > 0
        ? `Registered ${result.coreCount} compulsory subject${result.coreCount === 1 ? '' : 's'} for ${added} student${added === 1 ? '' : 's'}.${result.alreadyComplete ? ` ${result.alreadyComplete} already had all of them.` : ''}`
        : `Everyone already had all ${result.coreCount} compulsory subjects.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof StudentError ? err.message : 'Could not register subjects for this class.' };
  }
}
