import { NextResponse, type NextRequest } from 'next/server';
import { requireCandidate } from '@/lib/exam/guard';
import { saveAnswer } from '@/lib/exam/engine';

export const dynamic = 'force-dynamic';

/**
 * Save one answer.
 *
 * Returns whether it was accepted and NOTHING about whether it was right. A
 * response that leaked correctness would turn the paper into an answer key one
 * request at a time.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const candidate = await requireCandidate();

  if (!candidate) {
    return NextResponse.json({ ok: false, reason: 'not_signed_in' }, { status: 401 });
  }

  const { attemptId } = await params;
  const body = await req.json().catch(() => null);

  if (!body || typeof body.questionId !== 'number') {
    return NextResponse.json({ ok: false, reason: 'bad_request' }, { status: 400 });
  }

  const result = await saveAnswer(
    candidate.schoolId,
    Number(attemptId),
    candidate.studentId,
    {
      questionId: body.questionId,
      optionId: typeof body.optionId === 'number' ? body.optionId : null,
      text: typeof body.text === 'string' ? body.text : null,
      idempotencyKey: typeof body.key === 'string' ? body.key : undefined,
    },
  );

  // 'expired' is a normal outcome, not a server fault: the client should stop
  // retrying and show the submitted state.
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
