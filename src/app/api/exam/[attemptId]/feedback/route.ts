import { NextResponse, type NextRequest } from 'next/server';
import { requireCandidate } from '@/lib/exam/guard';
import { practiceFeedback } from '@/lib/exam/practice';

export const dynamic = 'force-dynamic';

// Practice feedback AFTER submission. The service refuses formal attempts —
// that guard lives in practiceFeedback, not in this route, so no caller can
// bypass it by hitting this endpoint directly with an exam attempt id.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const candidate = await requireCandidate();

  if (!candidate) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const { attemptId } = await params;

  const result = await practiceFeedback(
    candidate.schoolId,
    Number(attemptId),
    candidate.studentId,
  );

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : 403;
    return NextResponse.json({ ok: false, reason: result.reason }, { status });
  }

  return NextResponse.json({ ok: true, feedback: result.feedback });
}
