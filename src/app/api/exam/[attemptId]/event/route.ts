import { NextResponse, type NextRequest } from 'next/server';
import { requireCandidate } from '@/lib/exam/guard';
import { recordEvent } from '@/lib/exam/engine';

export const dynamic = 'force-dynamic';

const ALLOWED = ['window_blur', 'tab_hidden', 'right_click', 'fullscreen_exit'] as const;

/**
 * Record an integrity signal.
 *
 * The exam room warns the candidate that an action has been logged. Until this
 * route existed, that warning was untrue — the banner appeared and nothing was
 * written. A warning the system cannot back up is worse than none.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> },
) {
  const candidate = await requireCandidate();

  if (!candidate) return NextResponse.json({ ok: false }, { status: 401 });

  const { attemptId } = await params;
  const body = await req.json().catch(() => null);
  const type = body?.type;

  if (!ALLOWED.includes(type)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await recordEvent(candidate.schoolId, Number(attemptId), type);

  return NextResponse.json({ ok: true });
}
