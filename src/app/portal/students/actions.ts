'use server';

import { revalidatePath } from 'next/cache';
import { requireSchoolSession } from '@/lib/session';
import {
  StudentError, registerStudent, updateStudent, moveStudent,
  setStudentStanding, approveStudent, resetStudentPassword,
  linkGuardian, setStudentSubjects, subjectRegistrationView,
  importStudents, parseStudentCsv,
  type Standing,
} from '@/lib/people/students';
import { GuardianResetError, resetGuardianPassword } from '@/lib/people/guardians';
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

      const guardianName = [value('guardianFirstName').trim(), value('guardianLastName').trim()]
        .filter(Boolean).join(' ').trim();
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
        invite: result.guardianInviteToken
          ? `Invitation: /guardian/accept?t=${result.guardianInviteToken}`
          : undefined,
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
        parentName: value('parentName'),
        parentPhone: value('parentPhone'),
        parentEmail: value('parentEmail'),
        address: value('address'),
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

    if (operation === 'reset-guardian') {
      const guardianId = Number(value('guardianId'));
      try {
        const result = await resetGuardianPassword(actor, guardianId);
        revalidatePath(`/portal/students/${studentId}`);
        return {
          ok: true,
          message: `Password reset for ${result.name}.`,
          credentials: `Login ${result.loginId} — new temporary password ${result.temporaryPassword}. They must change it at next sign-in; their old sessions were signed out.`,
        };
      } catch (error) {
        if (error instanceof GuardianResetError) return { ok: false, message: error.message };
        throw error;
      }
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
          : result.inviteToken
            ? 'Existing guardian linked (deduplicated by email or phone). Their pending invitation is re-issued below.'
            : 'Existing guardian linked (deduplicated by email or phone). They already have an account — no invitation is needed.',
        invite: result.inviteToken ? `Invitation: /guardian/accept?t=${result.inviteToken}` : undefined,
      };
    }

    if (operation === 'import') {
      // The plugin's "Import many students": one class, one CSV, IDs and
      // passwords generated. Bad rows are reported, not silently skipped.
      const file = form.get('csv');
      if (!(file instanceof File) || file.size === 0) {
        return { ok: false, message: 'Choose a CSV file to import.' };
      }
      if (file.size > 1_000_000) {
        return { ok: false, message: 'That file is too large. Split it into smaller imports.' };
      }
      const text = await file.text();
      const { rows, errors } = parseStudentCsv(text);
      if (errors.length > 0) return { ok: false, message: errors[0]!.error };
      if (rows.length === 0) return { ok: false, message: 'The file has no student rows.' };
      if (rows.length > 500) return { ok: false, message: 'Import at most 500 students at a time.' };

      const result = await importStudents(actor, { classId: Number(value('classId')), rows });
      revalidatePath('/portal/students');

      const failures = result.outcomes.filter((o) => !o.ok);
      const lines = [
        `${result.created} student${result.created === 1 ? '' : 's'} imported`,
        result.pendingApproval ? ' (pending the office\'s approval)' : '',
        '.',
      ];
      const roster = result.outcomes.filter((o) => o.ok)
        .map((o) => `${o.admissionNumber} — password ${o.initialPassword}`)
        .join(' · ');
      return {
        ok: result.created > 0,
        message: `${lines.join('')}${failures.length ? ` ${failures.length} row(s) failed: ${failures.map((f) => `row ${f.row} (${f.error})`).join('; ')}.` : ''}`,
        credentials: roster || undefined,
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