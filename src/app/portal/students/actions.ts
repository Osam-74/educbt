'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import {
  StudentError, registerStudent, updateStudent, moveStudent,
  setStudentStanding, approveStudent, resetStudentPassword,
  linkGuardian, setStudentSubjects, subjectRegistrationView,
  type Standing,
} from '@/lib/people/students';
import { savePassportPhoto, PhotoError } from '@/lib/people/photos';

export type ActionState = { ok: boolean; message: string; credentials?: string; invite?: string };

export async function studentAction(_previous: ActionState, form: FormData): Promise<ActionState> {
  const actor = await requireSchoolSession();
  const value = (key: string) => {
    const v = form.get(key);
    return typeof v === 'string' ? v : '';
  };
  const operation = value('operation');
  const studentId = Number(value('studentId'));

  try {
    if (operation === 'register') {
      // A photograph is optional at intake; the office often has the paper
      // form before the photograph. Absent photo = keep whatever exists.
      const photoUrl = await savePassportPhoto(actor, form.get('photo'));

      const guardianName = value('guardianFullName').trim();
      const guardianEmail = value('guardianEmail').trim();
      const guardianPhone = value('guardianPhone').trim();

      const result = await registerStudent(actor, {
        firstName: value('firstName'),
        lastName: value('lastName'),
        gender: value('gender'),
        dateOfBirth: value('dateOfBirth'),
        admissionNumber: value('admissionNumber'),
        photoUrl: photoUrl ?? undefined,
        classId: Number(value('classId')),
        guardian: (guardianName && (guardianEmail || guardianPhone))
          ? { fullName: guardianName, email: guardianEmail, phone: guardianPhone }
          : undefined,
      });

      revalidatePath('/portal/students');

      const pendingNote = result.pendingApproval
        ? ' The record is pending the office\'s approval.'
        : '';
      return {
        ok: true,
        message: `${result.name} enrolled as ${result.admissionNumber} (student ID ${result.studentId}).${pendingNote}`,
        credentials: `Login ${result.loginId} — initial password ${result.initialPassword} (their surname). They must change it at first sign-in.`,
      };
    }

    if (operation === 'update') {
      const photoUrl = await savePassportPhoto(actor, form.get('photo'));
      await updateStudent(actor, {
        studentId,
        firstName: value('firstName'),
        lastName: value('lastName'),
        gender: value('gender'),
        dateOfBirth: value('dateOfBirth'),
        admissionNumber: value('admissionNumber'),
        photoUrl: photoUrl ?? undefined,
        classId: Number(value('classId')) || undefined,
      });

      revalidatePath('/portal/students');
      revalidatePath(`/portal/students/${studentId}`);
      return { ok: true, message: 'Student record updated.' };
    }

    if (operation === 'move') {
      await moveStudent(actor, studentId, Number(value('classId')));
      revalidatePath('/portal/students');
      revalidatePath(`/portal/students/${studentId}`);
      return { ok: true, message: 'Student moved for the current session. Past sessions are untouched.' };
    }

    if (operation === 'approve') {
      await approveStudent(actor, studentId);
      revalidatePath('/portal/students');
      return { ok: true, message: 'Student approved and enrolled.' };
    }

    if (operation === 'standing') {
      const standing = value('standing') as Standing;
      await setStudentStanding(actor, studentId, standing);
      revalidatePath('/portal/students');
      revalidatePath(`/portal/students/${studentId}`);
      return { ok: true, message: `Standing set to ${standing}.` };
    }

    if (operation === 'reset') {
      const result = await resetStudentPassword(actor, studentId);
      revalidatePath('/portal/students');
      revalidatePath(`/portal/students/${studentId}`);
      return {
        ok: true,
        message: `Password reset for ${result.name}.`,
        credentials: `Login ${result.loginId} — initial password ${result.initialPassword} (their surname). Old sessions were signed out.`,
      };
    }

    if (operation === 'link-guardian') {
      const result = await linkGuardian(actor, studentId, {
        fullName: value('guardianFullName'),
        email: value('guardianEmail'),
        phone: value('guardianPhone'),
        relationship: value('relationship') || 'parent',
        canViewResults: value('canViewResults') !== 'off',
      });
      revalidatePath(`/portal/students/${studentId}`);
      return {
        ok: true,
        message: result.created
          ? 'Guardian created and linked. Give them the invitation below — they choose their own password with it.'
          : 'Existing guardian linked to this student (deduplicated by email or phone).',
        invite: result.created ? `Invitation: /guardian/accept?t=${result.inviteToken}` : undefined,
      };
    }

    if (operation === 'register-subjects') {
      const electiveIds = form.getAll('electiveIds').map(Number).filter((n) => n > 0);
      const result = await setStudentSubjects(actor, studentId, electiveIds);
      const view = await subjectRegistrationView(actor, studentId);
      revalidatePath(`/portal/students/${studentId}`);
      return {
        ok: true,
        message: `${result.total} subjects registered for the current session (${view.core.length} compulsory, ${result.total - view.core.length} electives).`,
      };
    }

    return { ok: false, message: 'Unknown student action.' };
  } catch (error) {
    const message = error instanceof StudentError || error instanceof PhotoError
      ? error.message
      : 'That change could not be made. Reload the page and try again.';
    return { ok: false, message };
  }
}