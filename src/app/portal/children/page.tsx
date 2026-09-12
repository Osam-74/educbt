import { requireSchoolSession } from '@/lib/session';
import { forSchool } from '@/db';
import { guardianChildren } from '@/lib/results/family';
import FamilyChildren from './FamilyChildren';

export const dynamic = 'force-dynamic';

/**
 * "My Children" (legacy templates/portal/guardian/index.php). The parent
 * dashboard renders the same server-resolved list; both routes share
 * FamilyChildren so the states can never drift apart.
 */
export default async function ChildrenPage() {
  const actor = await requireSchoolSession();

  if (actor.role !== 'parent') {
    return (
      <>
        <h1 className="page-title">My Children</h1>
        <p>Children are shown on the parent&apos;s own account.</p>
      </>
    );
  }

  const children = await forSchool(actor.schoolId, (tx) => guardianChildren(tx, actor.userId));

  return (
    <>
      <h1 className="page-title">My Children</h1>
      <FamilyChildren children={children} />
    </>
  );
}
