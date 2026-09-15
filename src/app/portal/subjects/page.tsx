import { requireSchoolSession } from '@/lib/session';
import { subjectsView, type SubjectRow } from '@/lib/subjects/service';
import { AddSubjectForm, StandardListCard, SubjectsTable } from './SubjectsClient';

export const dynamic = 'force-dynamic';

/**
 * Subjects — ported from the plugin's school/subjects.php. Seeded with the
 * standard WAEC/BECE set; this screen is for the ones a school adds or
 * removes on top of that. MANAGE_SUBJECTS sits with the principal and vice
 * principal (capabilities.php); other roles see nothing here.
 */
export default async function SubjectsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireSchoolSession();
  if (!['principal', 'vice_principal'].includes(actor.role)) {
    return <><h1 className="page-title">Subjects</h1><p>You do not have access to manage subjects.</p></>;
  }

  const params = await searchParams;
  const one = (key: string) => {
    const v = params[key];
    return typeof v === 'string' ? v : '';
  };

  const view = await subjectsView(actor, {
    stage: one('stage'),
    assigned: one('assigned'),
    departmentId: Number(one('departmentId')) || 0,
  });

  const rows: SubjectRow[] = view.rows;

  return <>
    <h1 className="page-title">Subjects</h1>

    {!view.standardLoaded && <StandardListCard activeCount={view.activeCount} />}

    <AddSubjectForm departments={view.departments} />

    <SubjectsTable
      rows={rows}
      departments={view.departments}
      filters={{
        stage: one('stage') || 'all',
        assigned: one('assigned') || 'all',
        departmentId: Number(one('departmentId')) || 0,
      }}
    />
  </>;
}
