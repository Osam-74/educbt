import { requireSchoolSession } from '@/lib/session';
import { classTeacherRoster, rosterToCsv, rosterFileName } from '@/lib/people/rosters';

export const dynamic = 'force-dynamic';

/** Class teacher: download the students of a class you head. ?classId= */
export async function GET(req: Request) {
  const actor = await requireSchoolSession();
  const classId = Number(new URL(req.url).searchParams.get('classId'));
  if (!Number.isInteger(classId) || classId <= 0) return new Response('Not found', { status: 404 });

  const roster = await classTeacherRoster(actor, classId);
  if (!roster) return new Response('Not found', { status: 404 });

  return new Response(rosterToCsv(roster), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${rosterFileName(roster)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
