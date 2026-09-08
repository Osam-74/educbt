'use server';

/**
 * The single server action behind the school-creation form.
 *
 * All rules live in the service (src/lib/platform/schools.ts). This file only
 * translates form fields into input, and service outcomes into UI state —
 * including the ONE-TIME temporary password, which is returned in the action
 * result and rendered by the client form. It is never stored in the
 * database, the session, a cookie, or this server's memory.
 */

import { revalidatePath } from 'next/cache';
import { requirePlatformSession } from '@/lib/platform/session';
import {
  createSchoolWithPrincipal,
  DuplicateValueError,
  OnboardingValidationError,
  PlatformPermissionError,
  type OnboardedSchool,
} from '@/lib/platform/schools';

export type OnboardingState =
  | { status: 'idle' }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string>;
    }
  | { status: 'success'; result: OnboardedSchool };

export async function createSchoolAction(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const actor = await requirePlatformSession();

  const status: 'active' | 'suspended' =
    formData.get('status') === 'suspended' ? 'suspended' : 'active';
  const input = {
    name: String(formData.get('name') ?? ''),
    code: String(formData.get('code') ?? ''),
    email: String(formData.get('email') ?? ''),
    phone: String(formData.get('phone') ?? ''),
    address: String(formData.get('address') ?? ''),
    subdomain: String(formData.get('subdomain') ?? ''),
    status,
    principalFirstName: String(formData.get('principalFirstName') ?? ''),
    principalLastName: String(formData.get('principalLastName') ?? ''),
    principalLoginId: String(formData.get('principalLoginId') ?? ''),
  };

  try {
    const result = await createSchoolWithPrincipal(actor, input);

    revalidatePath('/platform');
    revalidatePath('/platform/schools');

    return { status: 'success', result };
  } catch (error) {
    if (error instanceof OnboardingValidationError) {
      return { status: 'error', message: error.message, fieldErrors: error.fieldErrors };
    }
    if (error instanceof DuplicateValueError) {
      return {
        status: 'error',
        message: error.message,
        fieldErrors: { [error.field]: error.message },
      };
    }
    if (error instanceof PlatformPermissionError) {
      return { status: 'error', message: error.message };
    }
    // Unknown failures get plain language, not a stack trace.
    return {
      status: 'error',
      message:
        'The school could not be created. Nothing was saved — please check the ' +
        'details and try again.',
    };
  }
}
