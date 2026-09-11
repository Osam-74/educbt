'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import {
  StaffError, registerStaff, updateStaff, resetStaffPassword,
  standDownStaff, reactivateStaff, assignBulk, dropAssignment,
  type StaffRole,
} from '@/lib/people/staff';
import { savePassportPhoto, PhotoError } from '@/lib/people/photos';

export type ActionState = { ok: boolean; message: string; credentials?: string; invite?: string };

/**
 * One dispatcher for every staff mutation on the page. The role check lives in
 * the service (defense in depth); this layer only translates forms and
 * revalidates.
 */
export async function staffAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireSchoolSession();
  const value = (key: string) => {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
  };
  const operation = value('operation');

  try {
    if (operation === 'register') {
      const photoUrl = await savePassportPhoto(actor, form.get('photo'));
      const result = await registerStaff(actor, {
        firstName: value('firstName'),
        lastName: value('lastName'),
        title: value('title'),
        gender: value('gender'),
        email: value('email'),
        phone: value('phone'),
        role: (value('role') || 'teacher') as StaffRole,
      });

      revalidatePath('/portal/staff');
      // The temporary password is shown ONCE, here. It is never stored or
      // emailed; the office hands it over in person.
      return {
        ok: true,
        message: `${result.name} registered as ${result.staffNumber}.`,
        credentials: `Login ${result.loginId} — temporary password ${result.temporaryPassword}. They must change it at first sign-in.`,
      };
    }

    if (operation === 'update') {
      // Absent file = keep the current photograph.
      const photoUrl = await savePassportPhoto(actor, form.get('photo'));
      await updateStaff(actor, {
        staffId: Number(value('staffId')),
        firstName: value('firstName'),
        lastName: value('lastName'),
        title: value('title'),
        email: value('email'),
        phone: value('phone'),
        role: value('role') ? (value('role') as StaffRole) : undefined,
        confirmTransfer: value('confirmTransfer') === 'on',
        photoUrl: photoUrl ?? undefined,
      });

      revalidatePath('/portal/staff');
      return { ok: true, message: 'Staff record updated.' };
    }

    if (operation === 'reset') {
      const result = await resetStaffPassword(actor, Number(value('staffId')));
      revalidatePath('/portal/staff');
      return {
        ok: true,
        message: `Password reset for ${result.name}.`,
        credentials: `Login ${result.loginId} — new temporary password ${result.temporaryPassword}. Their old sessions were signed out.`,
      };
    }

    if (operation === 'stand-down') {
      const result = await standDownStaff(actor, Number(value('staffId')), value('confirmReassign') === 'on');
      revalidatePath('/portal/staff');
      return {
        ok: true,
        message: `${result.name} stood down${result.released.length > 0 ? ` and released from ${result.released.length} assignment${result.released.length > 1 ? 's' : ''}` : ''}. Their login is disabled.`,
      };
    }

    if (operation === 'reactivate') {
      const name = await reactivateStaff(actor, Number(value('staffId')));
      revalidatePath('/portal/staff');
      return { ok: true, message: `${name} reactivated. Their login works again.` };
    }

    if (operation === 'assign') {
      const type = value('assignmentType') === 'class_teacher' ? 'class_teacher' as const : 'subject_teacher' as const;

      // The bulk form posts N rows of one teacher + many classes (+ subjects).
      // Grouped here so the form stays simple for the person using it.
      const staffId = Number(value('staffId'));
      const classIds = form.getAll('classIds').map(Number).filter((n) => n > 0);
      const subjectIds = form.getAll('subjectIds').map(Number).filter((n) => n > 0);
      const result = await assignBulk(actor, type, [{ staffId, classIds, subjectIds }]);

      revalidatePath('/portal/staff');
      const warning = result.problems.length > 0 ? ` Skipped: ${result.problems.join('; ')}.` : '';
      return { ok: true, message: `${result.saved} assignment${result.saved > 1 ? 's' : ''} saved.${warning}` };
    }

    if (operation === 'drop') {
      await dropAssignment(actor, Number(value('assignmentId')));
      revalidatePath('/portal/staff');
      return { ok: true, message: 'Assignment dropped.' };
    }

    return { ok: false, message: 'Unknown staff action.' };
  } catch (error) {
    const message = error instanceof StaffError || error instanceof PhotoError
      ? error.message
      : 'That change could not be made. Reload the page and try again.';
    return { ok: false, message };
  }
}
