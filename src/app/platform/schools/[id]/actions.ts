'use server';

/**
 * Activate / suspend a school. The service owns every rule; these actions
 * are glue: session guard, form translation, error surfacing.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import {
  setSchoolStatus,
  NotFoundError,
  OnboardingValidationError,
} from '@/lib/platform/schools';

function back(id: number, qs: Record<string, string>) {
  const params = new URLSearchParams(qs);
  redirect(`/platform/schools/${id}?${params.toString()}`);
}

export async function suspendSchoolAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformSession();
  const schoolId = Number(formData.get('schoolId'));

  try {
    await setSchoolStatus(actor, {
      schoolId,
      status: 'suspended',
      reason: String(formData.get('reason') ?? ''),
      confirm: formData.get('confirm') === 'on',
    });
  } catch (error) {
    if (error instanceof NotFoundError) back(schoolId, { error: error.message });
    if (error instanceof OnboardingValidationError) {
      back(schoolId, {
        error: Object.values(error.fieldErrors)[0] ?? error.message,
      });
    }
    back(schoolId, { error: 'The school could not be suspended. No changes were made.' });
  }

  revalidatePath(`/platform/schools/${schoolId}`);
  revalidatePath('/platform/schools');
  revalidatePath('/platform');
  back(schoolId, { ok: 'School suspended. Its users are signed out on their next request.' });
}

export async function reactivateSchoolAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformSession();
  const schoolId = Number(formData.get('schoolId'));

  try {
    await setSchoolStatus(actor, {
      schoolId,
      status: 'active',
      reason: String(formData.get('reason') ?? ''),
      confirm: formData.get('confirm') === 'on',
    });
  } catch (error) {
    if (error instanceof NotFoundError) back(schoolId, { error: error.message });
    if (error instanceof OnboardingValidationError) {
      back(schoolId, {
        error: Object.values(error.fieldErrors)[0] ?? error.message,
      });
    }
    back(schoolId, { error: 'The school could not be reactivated. No changes were made.' });
  }

  revalidatePath(`/platform/schools/${schoolId}`);
  revalidatePath('/platform/schools');
  revalidatePath('/platform');
  back(schoolId, { ok: 'School reactivated. Its users can sign in again.' });
}
