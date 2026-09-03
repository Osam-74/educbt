/**
 * Who is sitting this paper.
 *
 * Every exam endpoint starts here. The student is taken from the SESSION, never
 * from the request body — a candidate who edits a studentId in a payload must
 * change nothing.
 */

import { auth } from '@/lib/auth';

export type Candidate = { schoolId: number; studentId: number; userId: number };

export async function requireCandidate(): Promise<Candidate | null> {
  const user = await auth();

  if (!user) return null;
  if (user.role !== 'student') return null;
  if (!user.schoolId || !user.studentId) return null;

  return {
    schoolId: user.schoolId,
    studentId: user.studentId,
    userId: user.id,
  };
}
