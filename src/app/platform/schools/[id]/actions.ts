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
  issuePrincipalPassword,
  NotFoundError,
  OnboardingValidationError,
  type PrincipalPasswordIssue,
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

export type IssuePasswordState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'success'; result: PrincipalPasswordIssue };

/**
 * Issue the principal's temporary password. The password travels back in ACTION STATE and is rendered
 * once; it is never put in a URL, a redirect or a cookie (a URL ends up in logs and browser history).
 */
export async function issuePrincipalPasswordAction(_prev: IssuePasswordState, formData: FormData): Promise<IssuePasswordState> {
  const actor = await requirePlatformSession();
  const schoolId = Number(formData.get('schoolId'));
  if (formData.get('confirm') !== 'on') return { status: 'error', message: 'Tick the box to confirm. The principal\'s current password will stop working.' };
  try {
    const result = await issuePrincipalPassword(actor, schoolId);
    revalidatePath(`/platform/schools/${schoolId}`);
    return { status: 'success', result };
  } catch (error) {
    if (error instanceof NotFoundError) return { status: 'error', message: 'That school could not be found.' };
    if (error instanceof OnboardingValidationError) return { status: 'error', message: Object.values(error.fieldErrors)[0] ?? error.message };
    console.error('issuePrincipalPasswordAction failed', error);
    return { status: 'error', message: 'The password could not be issued. Nothing was changed.' };
  }
}

