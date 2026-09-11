import { requireSchoolSession } from '@/lib/session';
import { forSchool } from '@/db';
import { guardianChildren } from '@/lib/results/family';

export const dynamic = 'force-dynamic';

/**
 * A guardian's children with their published results
 * (legacy templates/portal/guardian/index.php, title "My Children": a parent
 * with three children signs in once and sees all three).
 *
 * Children come from the guardian_student link resolved from the SESSION user
 * on the server. can_view_results is honoured in the query itself: a restricted
 * child still appears (so the restriction is explained, exactly like legacy)
 * but carries no terms, and the report route refuses that guardian
 * independently — React never re-decides access.
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

      {children.length === 0 ? (
        <section className="card">
          <p className="muted">No children are linked to this account yet. Please contact the school office.</p>
        </section>
      ) : (
        children.map((child) => (
          <section key={child.id} className="card">
            <div className="family-child">
              {child.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="family-child__photo" src={child.photoUrl} alt="" />
              ) : null}
              <div>
                <h2>{child.firstName} {child.lastName}</h2>
                <p className="muted">
                  {child.admissionNumber ?? 'No admission number'}{child.className ? ' · ' + child.className : ''}
                </p>
              </div>
            </div>

            {!child.canViewResults ? (
              <p className="note">
                Results for this child are not shared with this account. The school office can change this.
              </p>
            ) : child.terms.length === 0 ? (
              <p className="muted">No results have been published yet.</p>
            ) : (
              <ul className="family-list">
                {child.terms.map((t) => (
                  <li key={t.termId}>
                    <span>
                      {t.termTitle}, {t.sessionTitle}
                      <br />
                      <span className="muted">
                        {t.className ?? 'No class recorded'} · {t.subjects} subject{t.subjects === 1 ? '' : 's'}
                      </span>
                    </span>
                    <a className="primary-wide" href={`/portal/reports/${child.id}?term=${t.termId}`}>
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </>
  );
}
