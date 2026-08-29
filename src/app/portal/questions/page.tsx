import Link from 'next/link';
import { requireSchoolSession } from '@/lib/session';
import { listSets } from '@/lib/exam/sets';
import { isSchoolWide } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  draft: 'In progress',
  submitted: 'Submitted',
  under_review: 'Under review',
  returned: 'Sent back',
  approved: 'Approved',
  published: 'Published',
};

export default async function QuestionSetsPage() {
  const actor = await requireSchoolSession();
  const sets = await listSets(actor);

  return (
    <>
      <h1 className="page-title">Question bank</h1>

      {sets.length === 0 ? (
        <p className="muted">
          No question sets yet. One is created the first time you save a question
          for a subject and level.
        </p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Subject</th><th>Level</th><th>Type</th>
              <th>Questions</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {sets.map((s) => {
              const short = s.questionCount < s.minRequired;

              return (
                <tr key={s.id}>
                  <td>
                    {s.subjectName} <span className="muted mono">{s.subjectCode}</span>
                    {/* Which bank this is. Without it a practice set and the
                        terminal paper for one subject look identical. */}
                    {s.seriesId > 0 ? <span className="tag">assessment</span> : null}
                    {s.waecMode ? <span className="tag">WAEC</span> : null}
                  </td>
                  <td>{s.levelName}{s.departmentName ? ` ${s.departmentName}` : ''}</td>
                  <td>{s.examType === 'objective' ? 'Objective' : 'Theory'}</td>
                  <td className={short ? 'short' : ''}>
                    {s.questionCount} / {s.minRequired}
                  </td>
                  <td><span className={`pill pill--${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span></td>
                  <td><Link href={`/portal/questions/${s.id}`}>Open</Link></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {isSchoolWide(actor.role) ? (
        <p className="muted" style={{ marginTop: 18 }}>
          You are seeing every set in the school. A teacher sees only their own.
        </p>
      ) : null}
    </>
  );
}
