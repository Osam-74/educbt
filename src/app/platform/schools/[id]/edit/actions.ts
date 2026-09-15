'use server';

/**
 * The server action behind Edit School. Mirrors schools/new/actions.ts's
 * shape (translate FormData → service input, service outcome → UI state),
 * but calls updateSchoolProfile — never createSchoolWithPrincipal — so there
 * is no principal/credential path here at all.
 */

import { revalidatePath } from 'next/cache';
import { requirePlatformSession } from '@/lib/platform/session';
import {
  updateSchoolProfile,
  DuplicateValueError,
  OnboardingValidationError,
  NotFoundError,
  PlatformPermissionError,
} from '@/lib/platform/schools';
import { normalizeImage } from '@/lib/settings/images';
import { SettingsError } from '@/lib/settings/service';

export type EditSchoolState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string> }
  | { status: 'success'; name: string };

export async function updateSchoolAction(
  _prev: EditSchoolState,
  formData: FormData,
): Promise<EditSchoolState> {
  const actor = await requirePlatformSession();
  const schoolId = Number(formData.get('schoolId'));

  const input = {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    phone: String(formData.get('phone') ?? ''),
    address: String(formData.get('address') ?? ''),
    subdomain: String(formData.get('subdomain') ?? ''),
  };

  try {
    const crestFile = formData.get('crest');
    const removeCrest = formData.get('removeCrest') === 'on';
    const crest = removeCrest
      ? null
      : crestFile instanceof File && crestFile.size
        ? await normalizeImage(crestFile)
        : undefined;

    const result = await updateSchoolProfile(actor, schoolId, input, crest);

    revalidatePath('/platform');
    revalidatePath('/platform/schools');
    revalidatePath(`/platform/schools/${schoolId}`);

    return { status: 'success', name: result.name };
  } catch (error) {
    if (error instanceof SettingsError) {
      return { status: 'error', message: error.message, fieldErrors: { crest: error.message } };
    }
    if (error instanceof OnboardingValidationError) {
      return { status: 'error', message: error.message, fieldErrors: error.fieldErrors };
    }
    if (error instanceof DuplicateValueError) {
      return { status: 'error', message: error.message, fieldErrors: { [error.field]: error.message } };
    }
    if (error instanceof NotFoundError) {
      return { status: 'error', message: error.message };
    }
    if (error instanceof PlatformPermissionError) {
      return { status: 'error', message: error.message };
    }
    return {
      status: 'error',
      message: 'The school could not be updated. Nothing was saved — please check the details and try again.',
    };
  }
}
