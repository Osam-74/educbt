'use server';

/**
 * The two server actions behind the platform-manager screen: create (the
 * useActionState form) and suspend/reactivate (plain forms in the table).
 *
 * All rules live in the service (src/lib/platform/managers.ts). This file
 * only translates form fields into input, and service outcomes into UI
 * state — including the ONE-TIME temporary password, which is returned in
 * the action result and rendered by the client form. It is never stored in
 * the database, the session, a cookie, or this server's memory.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/session';
import {
  createPlatformManager,
  setManagerStatus,
  ManagerConflictError,
  ManagerNotFoundError,
  ManagerPermissionError,
  ManagerValidationError,
} from '@/lib/platform/managers';

export type ManagerCreatedState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fieldErrors?: Record<string, string> }
  | { status: 'success'; result: { loginId: string; temporaryPassword: string } };

export async function createManagerAction(
  _prev: ManagerCreatedState,
  formData: FormData,
): Promise<ManagerCreatedState> {
  const actor = await requirePlatformSession();

  const input = {
    loginId: String(formData.get('loginId') ?? ''),
    email: String(formData.get('email') ?? ''),
  };

  try {
    const result = await createPlatformManager(actor, input);
    revalidatePath('/platform/managers');
    return { status: 'success', result };
  } catch (error) {
    if (error instanceof ManagerValidationError) {
      return { status: 'error', message: error.message, fieldErrors: error.fieldErrors };
    }
    if (error instanceof ManagerPermissionError) {
      return { status: 'error', message: error.message };
    }
    if (error instanceof ManagerConflictError) {
      return {
        status: 'error',
        message: error.message,
        fieldErrors: { loginId: error.message },
      };
    }
    console.error('createManagerAction failed', error);
    return { status: 'error', message: 'The manager could not be created.' };
  }
}

export async function setManagerStatusAction(formData: FormData): Promise<void> {
  const actor = await requirePlatformSession();

  const managerId = Number(formData.get('managerId'));
  const next = formData.get('status') === 'suspended' ? 'suspended' : 'active';

  if (!Number.isInteger(managerId) || managerId <= 0) {
    redirect(`/platform/managers?error=${encodeURIComponent('That manager could not be found.')}`);
  }

  try {
    await setManagerStatus(actor, managerId, next);
  } catch (error) {
    const message =
      error instanceof ManagerPermissionError ||
      error instanceof ManagerConflictError ||
      error instanceof ManagerNotFoundError
        ? error.message
        : 'The manager status could not be changed.';
    if (!(error instanceof ManagerPermissionError || error instanceof ManagerConflictError || error instanceof ManagerNotFoundError)) {
      console.error('setManagerStatusAction failed', error);
    }
    redirect(`/platform/managers?error=${encodeURIComponent(message)}`);
  }

  revalidatePath('/platform/managers');
  redirect('/platform/managers');
}
