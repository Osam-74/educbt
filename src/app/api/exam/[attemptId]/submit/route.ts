import { NextResponse, type NextRequest } from 'next/server';
import { requireCandidate } from '@/lib/exam/guard';
import { submitAttempt } from '@/lib/exam/engine';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const candidate = await requireCandidate();

  if (!candidate) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const { attemptId } = await params;

  const result = await submitAttempt(
    candidate.schoolId,
    Number(attemptId),
    candidate.studentId,
  );

  // The score is deliberately NOT returned. For a school examination the result
  // is published by the school after compilation, not handed to the candidate
  // as they leave the hall.
  return NextResponse.json({ ok: result.ok });
}
