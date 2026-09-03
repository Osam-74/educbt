/**
 * Session helpers used by every portal page and action.
 *
 * `requireSchoolSession()` is the one to reach for. It returns a tenant that has
 * been established from the SESSION, never from a URL or form field — which is
 * the difference between multi-tenancy and a suggestion.
 */

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export type Actor = {
  userId: number;
  schoolId: number;
  role: string;
  loginId: string;
  staffId: number | null;
  studentId: number | null;
};

export async function currentActor(): Promise<Actor | null> {
  const user = await auth();

  if (!user || !user.schoolId) return null;

  return {
    userId: user.id,
    schoolId: user.schoolId,
    role: user.role,
    loginId: user.loginId,
    staffId: user.staffId,
    studentId: user.studentId,
  };
}

export async function requireSchoolSession(): Promise<Actor> {
  const user = await auth();

  if (!user) redirect('/sign-in');

  if (user.mustChangePassword) redirect('/portal/account/password');

  if (!user.schoolId) redirect('/sign-in');

  return {
    userId: user.id,
    schoolId: user.schoolId,
    role: user.role,
    loginId: user.loginId,
    staffId: user.staffId,
    studentId: user.studentId,
  };
}

/**
 * Role gate. Checked on the SERVER for every protected action — hiding a menu
 * item is presentation, not authorisation.
 */
export function requireRole(actor: Actor, allowed: readonly string[]): void {
  if (!allowed.includes(actor.role)) {
    throw new Error('You do not have permission to do that.');
  }
}

export const SCHOOL_WIDE = ['principal', 'vice_principal', 'exam_officer'] as const;
