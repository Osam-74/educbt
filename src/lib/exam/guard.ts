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
  const session = await auth();

  if (!session?.user?.id) return null;
  if (session.user.role !== 'student') return null;
  if (!session.user.schoolId || !session.user.studentId) return null;

  return {
    schoolId: session.user.schoolId,
    studentId: session.user.studentId,
    userId: Number(session.user.id),
  };
}
