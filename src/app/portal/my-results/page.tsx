import { requireSchoolSession } from '@/lib/session';
import { forSchool } from '@/db';
import { familyPublishedTerms, studentSelf } from '@/lib/results/family';

export const dynamic = 'force-dynamic';

/**
 * A student's own published results (legacy templates/portal/student/results.php,
 * title "My Results"). No student id is ever taken from the URL: the signed-in
 * user resolves to their own student row on the server, so "self-access" is a
 * query constraint, not a hidden field.
 *
 * A term appears only when every one of its results is published or locked —
 * the same rule the report sheet enforces for the family audience — and each
 * row links straight into the existing /portal/reports route, which re-checks
 * audience and publication on its own. This page adds no second access path.
 */
export default async function MyResultsPage() {
  const actor = await requireSchoolSession();

  if (actor.role !== 'student') {
    return (
      <>
        <h1 className="page-title">My Results</h1>
        <p>Results are shown on the student&apos;s own account.</p>
      </>
    );
  }

  const data = await forSchool(actor.schoolId, async (tx) => {
    const self = await studentSelf(tx, actor.userId);
    // An unlinked student login has no record to list — the legacy behaviour
    // is the same empty answer, not an error page.
    if (!self) return null;
    return { studentId: self.id, terms: await familyPublishedTerms(tx, self.id) };
  });

  return (
    <>
      <h1 className="page-title">My Results</h1>

      {!data || data.terms.length === 0 ? (
        <section className="card">
          <p className="muted">No results have been published yet.</p>
        </section>
      ) : (
        <section className="card">
          <h2>Published results</h2>
          <ul className="family-list">
            {data.terms.map((t) => (
              <li key={t.termId}>
                <span>
                  <strong>{t.termTitle}, {t.sessionTitle}</strong>
                  <br />
                  <span className="muted">
                    {t.className ?? 'No class recorded'} · {t.subjects} subject{t.subjects === 1 ? '' : 's'}
                  </span>
                </span>
                <a className="primary-wide" href={`/portal/reports/${data.studentId}?term=${t.termId}`}>
                  Download
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
