import { requireSchoolSession } from '@/lib/session';
import { IMPORT_COLUMNS } from '@/lib/people/students-import';

/**
 * The import template (legacy educbt_export_students). Header only —
 * admission numbers and passwords are generated on import, never typed.
 */
export async function GET() {
  await requireSchoolSession();

  const body = `${IMPORT_COLUMNS.join(',')}\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="students-template.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
