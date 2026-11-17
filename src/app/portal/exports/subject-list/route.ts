import { requireSchoolSession } from '@/lib/session';
import { subjectTeacherRoster, rosterToCsv, rosterFileName } from '@/lib/people/rosters';

export const dynamic = 'force-dynamic';

/** Subject teacher: download the students of a class who take your subject. ?classId=&subjectId= */
export async function GET(req: Request) {
  const actor = await requireSchoolSession();
  const url = new URL(req.url);
  const classId = Number(url.searchParams.get('classId'));
  const subjectId = Number(url.searchParams.get('subjectId'));
  if (![classId, subjectId].every((n) => Number.isInteger(n) && n > 0)) return new Response('Not found', { status: 404 });

  const roster = await subjectTeacherRoster(actor, classId, subjectId);
  if (!roster) return new Response('Not found', { status: 404 });

  return new Response(rosterToCsv(roster), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${rosterFileName(roster)}"`,
      'Cache-Control': 'no-store',
    },
  });
}
